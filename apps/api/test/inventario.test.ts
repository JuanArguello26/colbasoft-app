import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista, DocumentoEntradaVista, ExistenciaReferencia, IdentificadorResumen, KardexVista, MotivoVista, PiezasDeLoteVista, ResolucionVista, SkuVista, UbicacionDeReferencia } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico, usuarioListo } from "./ayuda.js";

let app: FastifyInstance;
let admin: string, jefe: string, coord: string, aux1: string, auditor: string;
let bodega: BodegaVista;
let motivoAnulacion: MotivoVista;

beforeAll(async () => {
  app = await iniciarApp();
  [admin, jefe, coord, aux1, auditor] = await Promise.all(["admin", "jefe", "coordinador", "auxiliar1", "auditor"].map((l) => entrar(app, l)));
  bodega = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[])[0]!;
  motivoAnulacion = ((await pedir(app, jefe, "GET", "/api/motivos")).json() as MotivoVista[]).find((m) => m.tipoOperacion === "ANULACION")!;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---- ayudas ----
const hoy = () => new Date().toISOString().slice(0, 10);
const json = <T>(r: { json: () => unknown }) => r.json() as T;

/** Una categoría con su zona y ubicaciones, y una referencia en unidades con dos tallas: aísla la consulta del resto de las pruebas. */
async function escenario(ubicaciones = 3) {
  const categoria = json<{ id: string }>(await pedir(app, jefe, "POST", "/api/catalogo/categorias", { nombre: unico("Cat") }));
  const zona = json<{ id: string; codigo: string }>(await pedir(app, admin, "POST", `/api/bodega/bodegas/${bodega.id}/zonas`, { codigo: unico("Z").slice(0, 12).toUpperCase(), nombre: "Zona de prueba", tipo: "ALMACENAMIENTO" }));
  expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${zona.id}/categoria`, { categoriaId: categoria.id })).statusCode).toBe(200);
  const ubic: Array<{ id: string; codigo: string }> = [];
  for (let i = 0; i < ubicaciones; i++) {
    const codigo = (unico("U").slice(0, 14) + i).toUpperCase();
    ubic.push({ id: json<{ id: string }>(await pedir(app, admin, "POST", `/api/bodega/zonas/${zona.id}/ubicaciones`, { codigo })).id, codigo });
  }
  const tallaIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/tallas")).slice(0, 2).map((t) => t.id);
  const colorIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/colores")).slice(0, 1).map((t) => t.id);
  const ref = json<{ id: string; codigo: string }>(await pedir(app, jefe, "POST", "/api/catalogo/referencias", { codigo: unico("RK"), descripcion: "Referencia de kardex", categoriaId: categoria.id, unidadMedida: "UNIDADES", tallaIds, colorIds }));
  const todos = json<SkuVista[]>(await pedir(app, coord, "GET", "/api/lotes/skus"));
  return { zona, ubicaciones: ubic, ref, skus: todos.filter((s) => s.referencia === ref.codigo).sort((a, b) => a.talla.localeCompare(b.talla)) };
}

/** Entrada recibida por el Auxiliar y confirmada por el Jefe: la pieza queda EN RECEPCIÓN. */
async function entrada(sku: SkuVista, cantidad: number, tipo = "PAQUETE") {
  let d = json<DocumentoEntradaVista>(await pedir(app, coord, "POST", "/api/entradas", { bodegaId: bodega.id, origen: unico("Origen "), fechaEsperada: hoy(), lineas: [{ skuId: sku.id, cantidad }] }));
  d = json<DocumentoEntradaVista>(await pedir(app, aux1, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[0]!.id, tipo, cantidad }));
  const c = await pedir(app, jefe, "POST", `/api/entradas/${d.id}/confirmar`, { lotes: [{ lineaId: d.detalle[0]!.id, codigo: unico("LT") }] });
  expect(c.statusCode).toBe(200);
  return json<DocumentoEntradaVista>(c);
}
const ubicar = (piezaId: string, destinoId: string) => pedir(app, aux1, "POST", `/api/entradas/piezas/${piezaId}/ubicar`, { destinoId });
const kardex = (consulta: string, token = jefe) => pedir(app, token, "GET", `/api/inventario/kardex?${consulta}`);
const anular = (movimientoId: string, token = jefe, motivoId = motivoAnulacion.id) => pedir(app, token, "POST", `/api/inventario/movimientos/${movimientoId}/anular`, { motivoId });
const existencia = async (consulta: string, token = jefe) => json<ExistenciaReferencia[]>(await pedir(app, token, "GET", `/api/inventario/existencia?${consulta}`));

describe("HU-INV-001 · saber cuánto hay de una referencia", () => {
  it("criterios 1 y 2: devuelve la existencia por talla, color y lote, con el desglose por los cinco estados", async () => {
    const e = await escenario();
    const dA = await entrada(e.skus[0]!, 30);
    const dB = await entrada(e.skus[1]!, 12);
    expect((await ubicar(dA.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id)).statusCode).toBe(201);

    const [ref] = await existencia(`referenciaId=${e.ref.id}`);
    expect(ref).toMatchObject({ codigo: e.ref.codigo, total: 42, unidadMedida: "UNIDADES" });
    expect(ref!.porEstado).toEqual({ DISPONIBLE: 30, RESERVADO: 0, INMOVILIZADO: 0, EN_TRANSITO: 0, EN_RECEPCION: 12 });
    expect(ref!.detalle).toHaveLength(2);
    const a = ref!.detalle.find((x) => x.sku.id === e.skus[0]!.id)!;
    expect(a).toMatchObject({ lote: { codigo: dA.detalle[0]!.lote!.codigo }, total: 30, sku: { talla: e.skus[0]!.talla, color: e.skus[0]!.color } });
    expect(a.porEstado.DISPONIBLE).toBe(30);
    expect(ref!.detalle.find((x) => x.sku.id === e.skus[1]!.id)!.porEstado.EN_RECEPCION).toBe(12);
    expect(dB.detalle[0]!.lote).not.toBeNull();
  });

  it("busca por texto (código o descripción) y por lote o ubicación; una referencia sin existencia responde 0", async () => {
    const e = await escenario();
    expect((await existencia(`q=${e.ref.codigo.toLowerCase()}`))[0]).toMatchObject({ codigo: e.ref.codigo, total: 0, detalle: [] });
    const d = await entrada(e.skus[0]!, 8);
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[1]!.id);
    expect((await existencia(`loteId=${d.detalle[0]!.lote!.id}`))[0]).toMatchObject({ codigo: e.ref.codigo, total: 8 });
    expect((await existencia(`ubicacionId=${e.ubicaciones[1]!.id}`))[0]).toMatchObject({ codigo: e.ref.codigo, total: 8 });
    expect(await existencia(`ubicacionId=${e.ubicaciones[2]!.id}`)).toEqual([]); // sin existencia ahí
    expect(await existencia("")).toEqual([]); // sin criterio no se vuelca todo el inventario
  });

  it("criterio 4 (RN-INT-004): la cifra sale de los asientos del kardex y no hay ninguna columna de existencia", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 25);
    const derivada = await prisma.$queryRawUnsafe<Array<{ total: number }>>(`SELECT SUM(delta)::float8 AS total FROM "AsientoKardex" WHERE "piezaId" = $1`, d.detalle[0]!.piezas[0]!.id);
    expect((await existencia(`referenciaId=${e.ref.id}`))[0]!.total).toBe(derivada[0]!.total);
    const columnas = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('Pieza','Lote','Sku','Referencia','Ubicacion') AND column_name ILIKE '%existencia%'`);
    expect(columnas).toEqual([]);
  });

  it("todos los roles consultan; sin sesión no", async () => {
    const e = await escenario();
    for (const t of [admin, jefe, coord, aux1, auditor]) expect((await pedir(app, t, "GET", `/api/inventario/existencia?referenciaId=${e.ref.id}`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/inventario/existencia?q=x" })).statusCode).toBe(401);
  });
});

describe("HU-INV-002 · escanear una etiqueta y ver qué es y cuánto hay", () => {
  it("criterios 1, 2 y 4 (RF-INV-005, RF-INV-008): devuelve referencia, talla, color, lote, ubicación y existencia, sin costos, y no modifica nada", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 14);
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id);
    const qr = json<IdentificadorResumen>(await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: d.detalle[0]!.lote!.id })).codigo;

    const antes = { asientos: await prisma.asientoKardex.count(), movimientos: await prisma.movimiento.count() };
    const r = await pedir(app, aux1, "POST", "/api/identificadores/resolver", { codigo: qr });
    expect(r.statusCode).toBe(200);
    const v = json<ResolucionVista>(r);
    expect(v).toMatchObject({ tipo: "MERCANCIA", sku: { referencia: e.ref.codigo, talla: e.skus[0]!.talla, color: e.skus[0]!.color }, lote: { codigo: d.detalle[0]!.lote!.codigo } });
    if (v.tipo === "MERCANCIA") expect(v.ubicaciones).toEqual([{ ubicacionId: e.ubicaciones[0]!.id, ubicacion: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE", cantidad: 14 }]);
    expect(r.body).not.toMatch(/costo|precio|valor/i);
    expect({ asientos: await prisma.asientoKardex.count(), movimientos: await prisma.movimiento.count() }).toEqual(antes);
  });

  it("criterio 3: un identificador desconocido informa y ofrece reportar novedad", async () => {
    const r = await pedir(app, aux1, "POST", "/api/identificadores/resolver", { codigo: "COL-M-NOEXISTE-00000" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ reconocido: false, ofrecerNovedad: true });
  });
});

describe("HU-INV-003 · buscar dónde está una referencia", () => {
  it("criterios 1 a 4: lista todas las ubicaciones con su cantidad, ordena, filtra y marca lo no disponible", async () => {
    const e = await escenario();
    const grande = await entrada(e.skus[0]!, 40);
    const chica = await entrada(e.skus[1]!, 5);
    const enRecepcion = await entrada(e.skus[0]!, 7);
    await ubicar(grande.detalle[0]!.piezas[0]!.id, e.ubicaciones[2]!.id);
    await ubicar(chica.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id);
    const donde = (q = "") => pedir(app, aux1, "GET", `/api/inventario/donde-esta?referenciaId=${e.ref.id}${q}`);

    const porCantidad = json<UbicacionDeReferencia[]>(await donde());
    expect(porCantidad.map((u) => [u.cantidad, u.disponible])).toEqual([[40, true], [7, false], [5, true]]);
    expect(porCantidad[0]!.ubicacion).toBe(e.ubicaciones[2]!.codigo);
    expect(porCantidad[1]).toMatchObject({ estado: "EN_RECEPCION", disponible: false });

    const porZona = json<UbicacionDeReferencia[]>(await donde("&orden=zona"));
    expect(porZona).toHaveLength(3);
    expect(porZona.map((u) => u.zona + u.ubicacion)).toEqual([...porZona.map((u) => u.zona + u.ubicacion)].sort());

    const filtrada = json<UbicacionDeReferencia[]>(await donde(`&talla=${encodeURIComponent(e.skus[1]!.talla)}`));
    expect(filtrada.map((u) => u.cantidad)).toEqual([5]);
    const porLote = json<UbicacionDeReferencia[]>(await donde(`&lote=${grande.detalle[0]!.lote!.codigo.toLowerCase()}`));
    expect(porLote.map((u) => u.cantidad)).toEqual([40]);
    expect(enRecepcion.detalle[0]!.lote).not.toBeNull();
  });

  it("exige la referencia", async () => {
    expect((await pedir(app, aux1, "GET", "/api/inventario/donde-esta")).statusCode).toBe(422);
  });
});

describe("HU-KDX-001 · historia completa de una unidad de inventario", () => {
  it("criterios 1 a 3: movimientos en orden cronológico con fecha, tipo, cantidad, existencia resultante, ubicación, usuario y documento", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 20);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const k = json<KardexVista>(await kardex(`skuId=${e.skus[0]!.id}&loteId=${d.detalle[0]!.lote!.id}`, auditor));
    expect(k.lineas.map((l) => l.tipo)).toEqual(["ENTRADA", "MOVIMIENTO_INTERNO", "MOVIMIENTO_INTERNO"]);
    expect(k.lineas.map((l) => l.secuencia)).toEqual([...k.lineas.map((l) => l.secuencia)].sort((a, b) => a - b));
    expect(k.lineas.map((l) => l.cantidad)).toEqual([20, -20, 20]);
    expect(k.lineas.map((l) => l.existenciaResultante)).toEqual([20, 0, 20]);
    expect(k.lineas[0]).toMatchObject({ usuario: "jefe", documento: d.numero, pieza: p.numero, estado: "EN_RECEPCION", lote: d.detalle[0]!.lote!.codigo, motivo: null });
    expect(k.lineas[2]).toMatchObject({ usuario: "auxiliar1", ubicacion: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE" });
    expect(Date.parse(k.lineas[0]!.instante)).toBeLessThanOrEqual(Date.parse(k.lineas[2]!.instante));
    expect(k.existenciaFinal).toBe(20);
  });

  it("restringe por ubicación: la existencia resultante es la de esa unidad", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 9);
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[1]!.id);
    const k = json<KardexVista>(await kardex(`skuId=${e.skus[0]!.id}&loteId=${d.detalle[0]!.lote!.id}&ubicacionId=${e.ubicaciones[1]!.id}`));
    expect(k.lineas).toHaveLength(1);
    expect(k.lineas[0]).toMatchObject({ cantidad: 9, existenciaResultante: 9 });
  });

  it("criterio 4: sin huecos; cada línea es la anterior más su cantidad y la existencia nunca baja de cero", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 15);
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id);
    const k = json<KardexVista>(await kardex(`loteId=${d.detalle[0]!.lote!.id}`));
    expect(k.continuidad).toEqual({ ok: true, lineas: 3 });
    let previo = 0;
    for (const l of k.lineas) { expect(l.existenciaResultante).toBeCloseTo(previo + l.cantidad); previo = l.existenciaResultante; }
  });

  it("criterio 5: se exporta a CSV y la exportación queda en la bitácora", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 6);
    const antes = await prisma.registroBitacora.count({ where: { evento: "kardex_exportado" } });
    const r = await kardex(`loteId=${d.detalle[0]!.lote!.id}&formato=csv`, auditor);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain("kardex.csv");
    const filas = r.body.replace("﻿", "").split("\n");
    expect(filas[0]).toContain('"existencia_resultante"');
    expect(filas).toHaveLength(2);
    expect(filas[1]).toContain('"ENTRADA"');
    expect(await prisma.registroBitacora.count({ where: { evento: "kardex_exportado" } })).toBe(antes + 1);
  });

  it("pide qué consultar y exige sesión", async () => {
    expect((await kardex("")).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/inventario/kardex?skuId=x" })).statusCode).toBe(401);
  });

  it("matriz de permisos: el Auxiliar ve solo lo que él movió", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 11); // recibe auxiliar1, confirma jefe
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id); // ubica auxiliar1
    const otro = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    const ajeno = json<KardexVista>(await kardex(`loteId=${d.detalle[0]!.lote!.id}`, otro.token));
    expect(ajeno).toMatchObject({ lineas: [], restringido: true });
    const propio = json<KardexVista>(await kardex(`loteId=${d.detalle[0]!.lote!.id}`, aux1));
    expect(propio.lineas.map((l) => l.usuario)).toEqual(["auxiliar1", "auxiliar1"]); // ubicó, no confirmó la entrada
    expect(propio.restringido).toBe(true);
  });
});

describe("HU-KDX-002 · ningún movimiento se borra ni se edita", () => {
  it("criterio 1 (RF-KDX-003): no hay rutas de edición ni eliminación, para ningún rol; la base también las rechaza", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 4);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id } });
    for (const metodo of ["PUT", "PATCH", "DELETE"] as const) {
      for (const url of [`/api/inventario/movimientos/${mov.id}`, `/api/inventario/kardex/${mov.id}`, `/api/entradas/movimientos/${mov.id}`]) {
        const r = await app.inject({ method: metodo, url, cookies: { token: admin } });
        expect(r.statusCode, `${metodo} ${url}`).toBe(404);
      }
    }
    await expect(prisma.movimiento.update({ where: { id: mov.id }, data: { usuarioLogin: "otro" } })).rejects.toThrow(/inmutable/);
    await expect(prisma.movimiento.delete({ where: { id: mov.id } })).rejects.toThrow(/inmutable/);
    await expect(prisma.asientoKardex.deleteMany({ where: { movimientoId: mov.id } })).rejects.toThrow(/inmutable/);
  });

  it("criterios 2 y 3: un error se corrige con un movimiento inverso y ambos quedan visibles en el kardex", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 18);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id, tipo: "ENTRADA" } });
    const r = await anular(mov.id);
    expect(r.statusCode).toBe(201);
    const k = json<KardexVista>(await kardex(`loteId=${d.detalle[0]!.lote!.id}`));
    expect(k.lineas.map((l) => [l.tipo, l.cantidad, l.existenciaResultante])).toEqual([["ENTRADA", 18, 18], ["ANULACION", -18, 0]]);
    expect(k.lineas[0]!.anuladoPor).toBe(k.lineas[1]!.secuencia);
    expect(k.lineas[1]).toMatchObject({ anulaA: k.lineas[0]!.secuencia, motivo: motivoAnulacion.nombre, usuario: "jefe" });
    expect(k.existenciaFinal).toBe(0);
    expect((await existencia(`referenciaId=${e.ref.id}`))[0]!.total).toBe(0);
  });

  it("anula también un movimiento interno: la pieza vuelve a donde estaba", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 10);
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[0]!.id);
    const interno = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id, tipo: "MOVIMIENTO_INTERNO" } });
    expect((await anular(interno.id, admin)).statusCode).toBe(201);
    const [ref] = await existencia(`referenciaId=${e.ref.id}`);
    expect(ref!.porEstado).toMatchObject({ DISPONIBLE: 0, EN_RECEPCION: 10 });
  });

  it("criterio 4: exige motivo de anulación y el rol autorizado", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 3);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id } });
    expect((await pedir(app, jefe, "POST", `/api/inventario/movimientos/${mov.id}/anular`, {})).statusCode).toBe(422);
    const deAjuste = json<MotivoVista[]>(await pedir(app, jefe, "GET", "/api/motivos")).find((m) => m.tipoOperacion === "AJUSTE")!;
    expect((await anular(mov.id, jefe, deAjuste.id)).statusCode).toBe(422);
    expect((await anular(mov.id, jefe, "no-existe")).statusCode).toBe(422);
    for (const [t, rol] of [[coord, "coordinador"], [aux1, "auxiliar"], [auditor, "auditor"]] as const) {
      expect((await anular(mov.id, t)).statusCode, rol).toBe(403);
    }
    expect(await prisma.movimiento.count({ where: { anulaAId: mov.id } })).toBe(0);
  });

  it("un movimiento se anula una sola vez, una anulación no se anula y no se anula lo que ya se movió", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 10);
    const entradaMov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id, tipo: "ENTRADA" } });
    await ubicar(d.detalle[0]!.piezas[0]!.id, e.ubicaciones[0]!.id);
    // La mercancía ya salió de recepción: anular la entrada dejaría la existencia negativa.
    const conflicto = await anular(entradaMov.id);
    expect(conflicto.statusCode).toBe(409);
    expect(conflicto.json().error).toContain("por debajo de cero");
    expect(await prisma.movimiento.count({ where: { anulaAId: entradaMov.id } })).toBe(0); // la transacción se deshizo

    const interno = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id, tipo: "MOVIMIENTO_INTERNO" } });
    const primera = await anular(interno.id);
    expect(primera.statusCode).toBe(201);
    expect((await anular(interno.id)).statusCode).toBe(409);
    expect((await anular(primera.json().movimientoId)).json().error).toContain("no se anula");
    expect((await anular("no-existe")).statusCode).toBe(404);
    // Ahora sí se puede anular la entrada: todo volvió a recepción.
    expect((await anular(entradaMov.id)).statusCode).toBe(201);
  });

  it("criterio 5: la anulación queda en la bitácora", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 2);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id } });
    await anular(mov.id);
    const evento = await prisma.registroBitacora.findFirst({ where: { evento: "movimiento_anulado", entidadId: mov.id } });
    expect(evento).toMatchObject({ modulo: "KARDEX", usuarioLogin: "jefe" });
    expect(evento!.detalle).toMatchObject({ tipoOriginal: "ENTRADA", motivo: motivoAnulacion.nombre });
  });

  it("la base exige que una anulación diga qué neutraliza y con qué motivo", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 2);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id } });
    const base = { usuarioId: mov.usuarioId, usuarioLogin: "x", iniciadoEn: new Date() };
    await expect(prisma.movimiento.create({ data: { ...base, tipo: "ANULACION" } })).rejects.toThrow(/anulacion_coherente/);
    await expect(prisma.movimiento.create({ data: { ...base, tipo: "ENTRADA", anulaAId: mov.id } })).rejects.toThrow(/anulacion_coherente/);
  });
});

describe("HU-KDX-006 · dónde está y qué ha pasado con cada pieza de un lote", () => {
  it("criterio 1 (RF-INV-009): el lote muestra sus piezas con tipo, cantidad actual, ubicación y estado", async () => {
    const e = await escenario();
    let d = json<DocumentoEntradaVista>(await pedir(app, coord, "POST", "/api/entradas", { bodegaId: bodega.id, origen: unico("Origen "), fechaEsperada: hoy(), lineas: [{ skuId: e.skus[0]!.id, cantidad: 30 }] }));
    for (const cantidad of [10, 12, 8]) d = json<DocumentoEntradaVista>(await pedir(app, aux1, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[0]!.id, tipo: "BOLSA", cantidad }));
    expect((await pedir(app, jefe, "POST", `/api/entradas/${d.id}/confirmar`, { lotes: [{ lineaId: d.detalle[0]!.id, codigo: unico("LT") }] })).statusCode).toBe(200);
    d = json<DocumentoEntradaVista>(await pedir(app, coord, "GET", `/api/entradas/${d.id}`));
    await ubicar(d.detalle[0]!.piezas[1]!.id, e.ubicaciones[0]!.id);

    for (const t of [jefe, auditor, aux1]) {
      const r = json<PiezasDeLoteVista>(await pedir(app, t, "GET", `/api/inventario/lotes/${d.detalle[0]!.lote!.id}/piezas`));
      expect(r.lote.codigo).toBe(d.detalle[0]!.lote!.codigo);
      expect(r.piezas.map((p) => [p.tipo, p.cantidad, p.cantidadActual])).toEqual([["BOLSA", 10, 10], ["BOLSA", 12, 12], ["BOLSA", 8, 8]]);
      expect(r.piezas[0]!.ubicaciones[0]).toMatchObject({ estado: "EN_RECEPCION", cantidad: 10 });
      expect(r.piezas[1]!.ubicaciones).toEqual([{ ubicacionId: e.ubicaciones[0]!.id, ubicacion: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE", cantidad: 12 }]);
    }
    expect((await pedir(app, jefe, "GET", "/api/inventario/lotes/no-existe/piezas")).statusCode).toBe(404);
  });

  it("criterios 2 a 4: el kardex de una pieza, en orden y sin necesitar un QR propio, responde las seis preguntas", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 16, "BOLSA");
    const p = d.detalle[0]!.piezas[0]!;
    await ubicar(p.id, e.ubicaciones[2]!.id);
    const k = json<KardexVista>(await kardex(`piezaId=${p.id}`, auditor));
    expect(k.lineas.map((l) => l.secuencia)).toEqual([...k.lineas.map((l) => l.secuencia)].sort((a, b) => a - b));
    expect(k.lineas.every((l) => l.pieza === p.numero)).toBe(true);
    const ultima = k.lineas.at(-1)!;
    // qué (pieza y SKU), cuánto, dónde, quién, cuándo y por qué (tipo y documento).
    expect(ultima).toMatchObject({ pieza: p.numero, sku: { referencia: e.ref.codigo }, cantidad: 16, ubicacion: e.ubicaciones[2]!.codigo, usuario: "auxiliar1", tipo: "MOVIMIENTO_INTERNO", documento: d.numero });
    expect(ultima.instante).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await prisma.identificador.count({ where: { loteId: d.detalle[0]!.lote!.id } })).toBe(0); // la pieza se resolvió sin QR
  });

  it("criterio 5: la consulta de un lote con muchas piezas responde en menos de un segundo", async () => {
    const e = await escenario();
    const d = await entrada(e.skus[0]!, 5);
    const t0 = performance.now();
    await pedir(app, jefe, "GET", `/api/inventario/lotes/${d.detalle[0]!.lote!.id}/piezas`);
    await kardex(`loteId=${d.detalle[0]!.lote!.id}`);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
