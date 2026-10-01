import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista, DocumentoEntradaVista, IdentificadorResumen, KardexVista, MovimientoInternoResultado, PiezasMovibles, SkuVista } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string, jefe: string, coord: string, aux1: string, auditor: string;
let bodega: BodegaVista;

beforeAll(async () => {
  app = await iniciarApp();
  [admin, jefe, coord, aux1, auditor] = await Promise.all(["admin", "jefe", "coordinador", "auxiliar1", "auditor"].map((l) => entrar(app, l)));
  bodega = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[])[0]!;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const hoy = () => new Date().toISOString().slice(0, 10);
const json = <T>(r: { json: () => unknown }) => r.json() as T;

/** Zona de almacenamiento propia con ubicaciones (capacidad en unidades, o sin límite) y una referencia en unidades. */
async function escenario(capacidades: Array<number | null>) {
  const categoria = json<{ id: string }>(await pedir(app, jefe, "POST", "/api/catalogo/categorias", { nombre: unico("Cat") }));
  const zona = json<{ id: string }>(await pedir(app, admin, "POST", `/api/bodega/bodegas/${bodega.id}/zonas`, { codigo: unico("Z").slice(0, 12).toUpperCase(), nombre: "Zona de prueba", tipo: "ALMACENAMIENTO" }));
  expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${zona.id}/categoria`, { categoriaId: categoria.id })).statusCode).toBe(200);
  const ubicaciones: Array<{ id: string; codigo: string }> = [];
  for (const [i, cap] of capacidades.entries()) {
    const codigo = (unico("U").slice(0, 14) + i).toUpperCase();
    const r = await pedir(app, admin, "POST", `/api/bodega/zonas/${zona.id}/ubicaciones`, { codigo, ...(cap === null ? {} : { capacidad: cap, unidadCapacidad: "UNIDADES" }) });
    ubicaciones.push({ id: json<{ id: string }>(r).id, codigo });
  }
  const tallaIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/tallas")).slice(0, 1).map((t) => t.id);
  const colorIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/colores")).slice(0, 1).map((t) => t.id);
  const ref = json<{ id: string; codigo: string }>(await pedir(app, jefe, "POST", "/api/catalogo/referencias", { codigo: unico("RM"), descripcion: "Referencia de movimientos", categoriaId: categoria.id, unidadMedida: "UNIDADES", tallaIds, colorIds }));
  const sku = json<SkuVista[]>(await pedir(app, coord, "GET", "/api/lotes/skus")).find((s) => s.referencia === ref.codigo)!;
  return { ubicaciones, sku };
}

/** Entrada confirmada con varias piezas (una por cantidad), todas en recepción. */
async function entrada(sku: SkuVista, cantidades: number[]) {
  let d = json<DocumentoEntradaVista>(await pedir(app, coord, "POST", "/api/entradas", { bodegaId: bodega.id, origen: unico("Origen "), fechaEsperada: hoy(), lineas: [{ skuId: sku.id, cantidad: cantidades.reduce((a, b) => a + b, 0) }] }));
  for (const cantidad of cantidades) d = json<DocumentoEntradaVista>(await pedir(app, aux1, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[0]!.id, tipo: "PAQUETE", cantidad }));
  const c = await pedir(app, jefe, "POST", `/api/entradas/${d.id}/confirmar`, { lotes: [{ lineaId: d.detalle[0]!.id, codigo: unico("LT") }] });
  expect(c.statusCode).toBe(200);
  return json<DocumentoEntradaVista>(await pedir(app, coord, "GET", `/api/entradas/${d.id}`));
}
const ubicar = async (piezaId: string, destinoId: string) => expect((await pedir(app, aux1, "POST", `/api/entradas/piezas/${piezaId}/ubicar`, { destinoId })).statusCode).toBe(201);
const mover = (cuerpo: object, token = aux1) => pedir(app, token, "POST", "/api/movimientos/internos", cuerpo);
const piezasDe = async (query: string, token = aux1) => pedir(app, token, "GET", `/api/movimientos/piezas?${query}`);
const total = async (loteId: string) => Number((await prisma.$queryRawUnsafe<Array<{ t: number }>>(`SELECT COALESCE(SUM(a.delta),0)::float8 AS t FROM "AsientoKardex" a JOIN "Pieza" p ON p.id=a."piezaId" JOIN "LineaEntrada" l ON l.id=p."lineaId" WHERE l."loteId"=$1`, loteId))[0]!.t);
const qrMercancia = async (loteId: string) => json<IdentificadorResumen>(await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId })).codigo;
const qrUbicacion = async (id: string) => json<{ identificadores: IdentificadorResumen[] }>(await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [id] })).identificadores[0]!.codigo;

describe("HU-MOV-001 · registrar que se movió mercancía de un estante a otro", () => {
  it("criterios 1, 3, 4 y 5: escaneando mercancía y destino se registra un movimiento interno que no cambia el total y queda en el kardex", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [20]);
    const p = d.detalle[0]!.piezas[0]!;
    const loteId = d.detalle[0]!.lote!.id;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const antes = await total(loteId);
    const qrM = await qrMercancia(loteId);
    const qrD = await qrUbicacion(e.ubicaciones[1]!.id);

    const r = await mover({ piezaId: p.id, mercanciaCodigo: qrM.toLowerCase(), destinoCodigo: qrD });
    expect(r.statusCode).toBe(201);
    expect(json<MovimientoInternoResultado>(r)).toMatchObject({ pieza: p.numero, cantidad: 20, origen: e.ubicaciones[0]!.codigo, destino: e.ubicaciones[1]!.codigo, modo: "ESCANEO" });
    expect(await total(loteId)).toBe(antes); // RN-MOV-004
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { id: json<MovimientoInternoResultado>(r).movimientoId }, include: { asientos: true } });
    expect(mov.asientos.map((a) => Number(a.delta)).sort((x, y) => x - y)).toEqual([-20, 20]);
    expect(mov.asientos.every((a) => a.estado === "DISPONIBLE")).toBe(true);

    const k = json<KardexVista>(await pedir(app, jefe, "GET", `/api/inventario/kardex?piezaId=${p.id}`));
    const ultimas = k.lineas.slice(-2);
    expect(ultimas.map((l) => [l.tipo, l.cantidad, l.ubicacion, l.usuario, l.pieza])).toEqual([
      ["MOVIMIENTO_INTERNO", -20, e.ubicaciones[0]!.codigo, "auxiliar1", p.numero],
      ["MOVIMIENTO_INTERNO", 20, e.ubicaciones[1]!.codigo, "auxiliar1", p.numero],
    ]);
    expect(await prisma.registroBitacora.count({ where: { evento: "movimiento_interno", entidadId: mov.id } })).toBe(1);
  });

  it("sin escanear (selección) queda como identificación manual", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [5]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    expect(json<MovimientoInternoResultado>(await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id })).modo).toBe("MANUAL");
  });

  it("criterio 2 (RN-MOV-012): se mueve la pieza completa; una parte es un corte parcial, no un movimiento", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [30]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const parcial = await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id, cantidad: 10 });
    expect(parcial.statusCode).toBe(409);
    expect(parcial.json().error).toContain("no se divide");
    expect(parcial.json().error).toContain("salida");
    expect((await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id, cantidad: 30 })).statusCode).toBe(201);
  });

  it("la pieza queda en el destino y el mismo movimiento no se puede repetir desde el origen", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [8]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    expect((await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id })).statusCode).toBe(201);
    const otra = await mover({ piezaId: p.id, origenId: e.ubicaciones[0]!.id, destinoId: e.ubicaciones[1]!.id });
    expect(otra.statusCode).toBe(409);
    expect(otra.json().error).toContain("no registra esa pieza");
  });

  it("dos movimientos simultáneos de la misma pieza: solo uno se aplica y el otro se explica", async () => {
    const e = await escenario([null, null, null]);
    const d = await entrada(e.sku, [12]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const [a, b] = await Promise.all([mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id }), mover({ piezaId: p.id, destinoId: e.ubicaciones[2]!.id }, jefe)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error).toContain("alguien la movió");
    expect(await total(d.detalle[0]!.lote!.id)).toBe(12);
  });

  it("permisos: el Auditor nunca escribe inventario; sin sesión no hay acceso", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [3]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    expect((await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id }, auditor)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/movimientos/internos", payload: {} })).statusCode).toBe(401);
    for (const t of [admin, coord]) { // quienes supervisan también pueden mover
      expect((await mover({ piezaId: p.id, destinoId: e.ubicaciones[t === admin ? 1 : 0]!.id }, t)).statusCode).toBe(201);
    }
  });
});

describe("HU-MOV-002 · impedir movimientos imposibles", () => {
  it("criterio 1: se rechaza mover más de lo existente en el origen", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const r = await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id, cantidad: 11 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("más de lo que hay");
    expect(await prisma.movimiento.count({ where: { tipo: "MOVIMIENTO_INTERNO", asientos: { some: { piezaId: p.id, ubicacionId: e.ubicaciones[1]!.id } } } })).toBe(0);
  });

  it("criterio 2: se rechaza el destino igual al origen", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const r = await mover({ piezaId: p.id, destinoId: e.ubicaciones[0]!.id });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("misma ubicación");
  });

  it("criterio 3: se rechaza un destino inactivo, sin capacidad o de otro tipo de zona", async () => {
    const e = await escenario([null, 5, null]);
    const d = await entrada(e.sku, [10]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const sinCupo = await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id }); // capacidad 5 < 10
    expect(sinCupo.statusCode).toBe(409);
    expect(sinCupo.json().error).toContain("No hay capacidad");
    expect((await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${e.ubicaciones[2]!.id}/desactivar`)).statusCode).toBe(200);
    const inactivo = await mover({ piezaId: p.id, destinoId: e.ubicaciones[2]!.id });
    expect(inactivo.statusCode).toBe(409);
    expect(inactivo.json().error).toContain("desactivada");
    const recepcion = bodega.zonas.find((z) => z.tipo === "RECEPCION")!.ubicaciones[0]!;
    const aRecepcion = await mover({ piezaId: p.id, destinoId: recepcion.id });
    expect(aRecepcion.statusCode).toBe(409);
    expect(aRecepcion.json().error).toContain("recepción");
  });

  it("criterio 4: no se mueve existencia que no está disponible (en recepción se ubica desde la entrada)", async () => {
    const e = await escenario([null]);
    const d = await entrada(e.sku, [10]);
    const p = d.detalle[0]!.piezas[0]!;
    const r = await mover({ piezaId: p.id, destinoId: e.ubicaciones[0]!.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("sigue en recepción");
  });

  it("criterio 5: cada rechazo explica el motivo en lenguaje comprensible (nunca un error técnico)", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const rechazos = [
      await mover({ piezaId: p.id, destinoId: e.ubicaciones[0]!.id }),
      await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id, cantidad: 99 }),
      await mover({ piezaId: p.id, destinoId: "no-existe" }),
      await mover({ piezaId: p.id }),
      await mover({ piezaId: "no-existe", destinoId: e.ubicaciones[1]!.id }),
      await mover({ piezaId: p.id, destinoCodigo: "COL-U-NOEXISTE-00000" }),
    ];
    for (const r of rechazos) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      const msg = r.json().error as string;
      expect(msg.length).toBeGreaterThan(15);
      expect(msg).not.toMatch(/prisma|constraint|violat|stack|undefined|RN-EXI/i);
    }
  });
});

describe("HU-MOV-008 · elegir en pantalla la pieza que se ubica o se mueve", () => {
  it("criterio 1: tras escanear el QR del SKU + Lote se muestran las piezas del lote", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10, 12, 8]);
    const loteId = d.detalle[0]!.lote!.id;
    await ubicar(d.detalle[0]!.piezas[1]!.id, e.ubicaciones[0]!.id);
    const qr = await qrMercancia(loteId);
    const r = json<PiezasMovibles>(await piezasDe(`mercanciaCodigo=${qr.toLowerCase()}`));
    expect(r.lote.codigo).toBe(d.detalle[0]!.lote!.codigo);
    expect(r.piezas.map((p) => [p.cantidad, p.estado, p.movible])).toEqual([[10, "EN_RECEPCION", false], [12, "DISPONIBLE", true], [8, "EN_RECEPCION", false]]);
  });

  it("criterio 2: con varias piezas del mismo lote, la ubicación filtra y verifica las que se ofrecen", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10, 12, 8]);
    const loteId = d.detalle[0]!.lote!.id;
    const [p1, p2, p3] = d.detalle[0]!.piezas;
    await ubicar(p1!.id, e.ubicaciones[0]!.id);
    await ubicar(p2!.id, e.ubicaciones[0]!.id);
    await ubicar(p3!.id, e.ubicaciones[1]!.id);
    const qrM = await qrMercancia(loteId);
    const qrU = await qrUbicacion(e.ubicaciones[0]!.id);
    const porCodigo = json<PiezasMovibles>(await piezasDe(`mercanciaCodigo=${qrM}&ubicacionCodigo=${qrU}`));
    expect(porCodigo.piezas.map((p) => p.numero).sort()).toEqual([p1!.numero, p2!.numero].sort());
    const porId = json<PiezasMovibles>(await piezasDe(`loteId=${loteId}&ubicacionId=${e.ubicaciones[1]!.id}`));
    expect(porId.piezas.map((p) => p.numero)).toEqual([p3!.numero]);
    // La pieza que el sistema no registra en el origen indicado se rechaza al mover.
    const r = await mover({ piezaId: p3!.id, origenCodigo: qrU, destinoId: e.ubicaciones[1]!.id });
    expect(r.statusCode).toBe(409);
  });

  it("criterio 3: no se confirma un movimiento sin pieza seleccionada", async () => {
    const e = await escenario([null, null]);
    const r = await mover({ destinoId: e.ubicaciones[1]!.id });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("pieza");
  });

  it("criterio 4: la primera ubicación desde recepción también se hace sobre una pieza concreta", async () => {
    const e = await escenario([null]);
    const d = await entrada(e.sku, [10, 7]);
    const [p1, p2] = d.detalle[0]!.piezas;
    expect((await pedir(app, aux1, "POST", `/api/entradas/piezas/no-existe/ubicar`, { destinoId: e.ubicaciones[0]!.id })).statusCode).toBe(404);
    await ubicar(p1!.id, e.ubicaciones[0]!.id);
    const luego = json<DocumentoEntradaVista>(await pedir(app, coord, "GET", `/api/entradas/${d.id}`)).detalle[0]!.piezas;
    expect(luego.find((p) => p.id === p1!.id)!.ubicaciones[0]).toMatchObject({ estado: "DISPONIBLE" });
    expect(luego.find((p) => p.id === p2!.id)!.ubicaciones[0]).toMatchObject({ estado: "EN_RECEPCION" }); // la otra pieza no se tocó
  });

  it("criterios 5 y 6: el kardex muestra la pieza y el total no cambia", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [10, 6]);
    const loteId = d.detalle[0]!.lote!.id;
    const [p1, p2] = d.detalle[0]!.piezas;
    await ubicar(p1!.id, e.ubicaciones[0]!.id);
    await ubicar(p2!.id, e.ubicaciones[0]!.id);
    const antes = await total(loteId);
    expect((await mover({ piezaId: p2!.id, destinoId: e.ubicaciones[1]!.id })).statusCode).toBe(201);
    expect(await total(loteId)).toBe(antes);
    const k = json<KardexVista>(await pedir(app, jefe, "GET", `/api/inventario/kardex?loteId=${loteId}`));
    const delMovimiento = k.lineas.filter((l) => l.tipo === "MOVIMIENTO_INTERNO").slice(-2);
    expect(delMovimiento.every((l) => l.pieza === p2!.numero)).toBe(true);
    // La otra pieza sigue donde estaba.
    const r = json<PiezasMovibles>(await piezasDe(`loteId=${loteId}`));
    expect(r.piezas.find((p) => p.id === p1!.id)!.ubicacion).toBe(e.ubicaciones[0]!.codigo);
    expect(r.piezas.find((p) => p.id === p2!.id)!.ubicacion).toBe(e.ubicaciones[1]!.codigo);
  });

  it("un QR desconocido ofrece reportar novedad; la consulta no modifica nada", async () => {
    const antes = await prisma.asientoKardex.count();
    const r = await piezasDe("mercanciaCodigo=COL-M-NOEXISTE-00000");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ ofrecerNovedad: true });
    expect((await piezasDe("")).statusCode).toBe(422);
    expect(await prisma.asientoKardex.count()).toBe(antes);
  });

  it("un movimiento interno se puede anular con un movimiento inverso: la pieza vuelve al origen", async () => {
    const e = await escenario([null, null]);
    const d = await entrada(e.sku, [9]);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const m = json<MovimientoInternoResultado>(await mover({ piezaId: p.id, destinoId: e.ubicaciones[1]!.id }));
    const motivo = json<Array<{ id: string; tipoOperacion: string }>>(await pedir(app, jefe, "GET", "/api/motivos")).find((x) => x.tipoOperacion === "ANULACION")!;
    expect((await pedir(app, jefe, "POST", `/api/inventario/movimientos/${m.movimientoId}/anular`, { motivoId: motivo.id })).statusCode).toBe(201);
    const r = json<PiezasMovibles>(await piezasDe(`loteId=${d.detalle[0]!.lote!.id}`));
    expect(r.piezas[0]).toMatchObject({ ubicacion: e.ubicaciones[0]!.codigo, cantidad: 9 });
  });
});
