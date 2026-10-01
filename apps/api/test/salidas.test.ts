import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista, DocumentoEntradaVista, ExistenciaReferencia, IdentificadorResumen, KardexVista, MotivoVista, SalidaVista, SkuVista, TomaResultado } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string, jefe: string, coord: string, aux1: string, auditor: string;
let bodega: BodegaVista;
let motivo: MotivoVista;

beforeAll(async () => {
  app = await iniciarApp();
  [admin, jefe, coord, aux1, auditor] = await Promise.all(["admin", "jefe", "coordinador", "auxiliar1", "auditor"].map((l) => entrar(app, l)));
  bodega = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[])[0]!;
  motivo = (json<MotivoVista[]>(await pedir(app, jefe, "GET", "/api/motivos"))).find((m) => m.tipoOperacion === "SALIDA" && m.nombre === "Despacho")!;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const hoy = () => new Date().toISOString().slice(0, 10);
const json = <T>(r: { json: () => unknown }) => r.json() as T;

/** Zona de almacenamiento propia y una referencia en unidades con dos SKU (dos tallas): aísla cada prueba del resto. */
async function escenario(nUbicaciones = 3) {
  const categoria = json<{ id: string }>(await pedir(app, jefe, "POST", "/api/catalogo/categorias", { nombre: unico("Cat") }));
  const zona = json<{ id: string }>(await pedir(app, admin, "POST", `/api/bodega/bodegas/${bodega.id}/zonas`, { codigo: unico("Z").slice(0, 12).toUpperCase(), nombre: "Zona de prueba", tipo: "ALMACENAMIENTO" }));
  expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${zona.id}/categoria`, { categoriaId: categoria.id })).statusCode).toBe(200);
  const ubicaciones: Array<{ id: string; codigo: string }> = [];
  for (let i = 0; i < nUbicaciones; i++) {
    const codigo = (unico("U").slice(0, 14) + i).toUpperCase();
    ubicaciones.push({ id: json<{ id: string }>(await pedir(app, admin, "POST", `/api/bodega/zonas/${zona.id}/ubicaciones`, { codigo })).id, codigo });
  }
  const tallaIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/tallas")).slice(0, 2).map((t) => t.id);
  const colorIds = json<Array<{ id: string }>>(await pedir(app, jefe, "GET", "/api/catalogo/colores")).slice(0, 1).map((t) => t.id);
  const ref = json<{ id: string; codigo: string }>(await pedir(app, jefe, "POST", "/api/catalogo/referencias", { codigo: unico("RS"), descripcion: "Referencia de salidas", categoriaId: categoria.id, unidadMedida: "UNIDADES", tallaIds, colorIds }));
  const skus = json<SkuVista[]>(await pedir(app, coord, "GET", "/api/lotes/skus")).filter((s) => s.referencia === ref.codigo).sort((a, b) => a.talla.localeCompare(b.talla));
  return { ubicaciones, skus };
}

/** Entrada confirmada con una pieza por cantidad, todas ubicadas (disponibles) en la ubicación dada. Devuelve el documento y los QR. */
async function stock(sku: SkuVista, cantidades: number[], ubicacionId: string, loteCodigo = unico("LT")) {
  let d = json<DocumentoEntradaVista>(await pedir(app, coord, "POST", "/api/entradas", { bodegaId: bodega.id, origen: unico("Origen "), fechaEsperada: hoy(), lineas: [{ skuId: sku.id, cantidad: cantidades.reduce((a, b) => a + b, 0) }] }));
  for (const cantidad of cantidades) d = json<DocumentoEntradaVista>(await pedir(app, aux1, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[0]!.id, tipo: "PAQUETE", cantidad }));
  expect((await pedir(app, jefe, "POST", `/api/entradas/${d.id}/confirmar`, { lotes: [{ lineaId: d.detalle[0]!.id, codigo: loteCodigo }] })).statusCode).toBe(200);
  d = json<DocumentoEntradaVista>(await pedir(app, coord, "GET", `/api/entradas/${d.id}`));
  for (const p of d.detalle[0]!.piezas) expect((await pedir(app, aux1, "POST", `/api/entradas/piezas/${p.id}/ubicar`, { destinoId: ubicacionId })).statusCode).toBe(201);
  const loteId = d.detalle[0]!.lote!.id;
  const qr = json<IdentificadorResumen>(await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId })).codigo;
  return { loteId, qr, piezas: d.detalle[0]!.piezas };
}

const pedirSalida = (lineas: Array<{ skuId: string; loteId?: string; cantidad: number }>, extra: object = {}, token = coord) =>
  pedir(app, token, "POST", "/api/salidas", { motivoId: motivo.id, lineas, ...extra });
const salida = async (lineas: Array<{ skuId: string; loteId?: string; cantidad: number }>, extra: object = {}) => {
  const r = await pedirSalida(lineas, extra);
  expect(r.statusCode, r.body).toBe(201);
  return json<SalidaVista>(r);
};
const autorizar = (id: string, token = jefe) => pedir(app, token, "POST", `/api/salidas/${id}/autorizar`);
const cancelar = (id: string, token = jefe) => pedir(app, token, "POST", `/api/salidas/${id}/cancelar`, {});
const tomar = (id: string, cuerpo: object, token = aux1) => pedir(app, token, "POST", `/api/salidas/${id}/tomar`, cuerpo);
const confirmar = (id: string, token = aux1) => pedir(app, token, "POST", `/api/salidas/${id}/confirmar`);
const ver = async (id: string) => json<SalidaVista>(await pedir(app, jefe, "GET", `/api/salidas/${id}`));
const existencia = async (refId: string) => json<ExistenciaReferencia[]>(await pedir(app, jefe, "GET", `/api/inventario/existencia?referenciaId=${refId}`))[0]!;
const refDe = async (sku: SkuVista) => (await prisma.sku.findUniqueOrThrow({ where: { id: sku.id } })).referenciaId;

describe("HU-SAL-001 · registrar una salida indicando su motivo", () => {
  it("criterio 1 (RN-SAL-002): exige un motivo tipificado de la lista de salidas", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const lineas = [{ skuId: e.skus[0]!.id, cantidad: 3 }];
    const sinMotivo = await pedir(app, coord, "POST", "/api/salidas", { lineas });
    expect(sinMotivo.statusCode).toBe(422);
    expect(sinMotivo.json().error).toContain("motivo");
    const deAnulacion = json<MotivoVista[]>(await pedir(app, jefe, "GET", "/api/motivos")).find((m) => m.tipoOperacion === "ANULACION")!;
    expect((await pedirSalida(lineas, { motivoId: deAnulacion.id })).statusCode).toBe(422);
    expect((await pedirSalida(lineas, { motivoId: "no-existe" })).statusCode).toBe(422);
    expect((await pedirSalida(lineas)).statusCode).toBe(201);
  });

  it("criterio 2 (DC-03): no solicita ni guarda cliente, precio, factura ni documento comercial", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const r = await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 2 }], { cliente: "ACME", precio: 5000, factura: "F-1" });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toMatch(/cliente|precio|factura|ACME/i);
    const columnas = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('Salida','LineaSalida') AND (column_name ILIKE '%cliente%' OR column_name ILIKE '%precio%' OR column_name ILIKE '%factura%' OR column_name ILIKE '%valor%')`);
    expect(columnas).toEqual([]);
  });

  it("criterio 3: se indican referencias, tallas, colores, lotes y cantidades", async () => {
    const e = await escenario();
    const a = await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    await stock(e.skus[1]!, [8], e.ubicaciones[1]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, loteId: a.loteId, cantidad: 4 }, { skuId: e.skus[1]!.id, cantidad: 5 }]);
    expect(s).toMatchObject({ estado: "SOLICITADA", motivo: "Despacho", solicitadaPor: "coordinador", lineas: 2, cantidad: 9, parcial: false });
    expect(s.detalle.map((l) => [l.sku.talla, l.lote?.id ?? null, l.cantidad])).toEqual(expect.arrayContaining([[e.skus[0]!.talla, a.loteId, 4], [e.skus[1]!.talla, null, 5]]));
    expect(await prisma.registroBitacora.count({ where: { evento: "salida_solicitada", entidadId: s.id } })).toBe(1);
  });

  it("criterio 4 (RN-EXI-003): verifica la existencia disponible antes de aceptar", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const r = await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 11 }]);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ disponible: 10, pedida: 11, ofrecerParcial: true });
    expect((await pedirSalida([{ skuId: e.skus[1]!.id, cantidad: 1 }])).json().error).toContain("No hay existencia disponible");
  });

  it("valida las líneas y los permisos (Auxiliar y Auditor no solicitan)", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    expect((await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 0 }])).statusCode).toBe(422);
    expect((await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1.5 }])).json().error).toContain("enteros");
    expect((await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1 }, { skuId: e.skus[0]!.id, cantidad: 2 }])).json().error).toContain("repite");
    expect((await pedirSalida([])).statusCode).toBe(422);
    expect((await pedirSalida([{ skuId: "no-existe", cantidad: 1 }])).statusCode).toBe(404);
    for (const t of [aux1, auditor]) expect((await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1 }], {}, t)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/salidas", payload: {} })).statusCode).toBe(401);
  });

  it("un motivo que exige evidencia (baja por daño) pide una observación", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const daño = json<MotivoVista[]>(await pedir(app, jefe, "GET", "/api/motivos")).find((m) => m.nombre === "Baja por daño")!;
    const sin = await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1 }], { motivoId: daño.id });
    expect(sin.statusCode).toBe(422);
    expect(sin.json().error).toContain("observación");
    expect((await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1 }], { motivoId: daño.id, observacion: "Mojado por goteras" })).statusCode).toBe(201);
  });
});

describe("HU-SAL-004 · impedir sacar más de lo que hay", () => {
  it("criterios 1, 2 y 4: rechaza, informa cuánto hay y deja el rechazo registrado", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [6], e.ubicaciones[0]!.id);
    const antes = await prisma.registroBitacora.count({ where: { evento: "salida_rechazada_existencia_insuficiente" } });
    const r = await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 9 }]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("Solo hay 6 disponible");
    expect(await prisma.registroBitacora.count({ where: { evento: "salida_rechazada_existencia_insuficiente" } })).toBe(antes + 1);
    // Ninguna salida, ni siquiera parcial, deja el inventario negativo: la base lo impide aunque se saltaran las reglas del servicio.
    await expect(prisma.asientoKardex.create({ data: { movimientoId: (await prisma.movimiento.findFirstOrThrow()).id, piezaId: (await prisma.pieza.findFirstOrThrow()).id, ubicacionId: e.ubicaciones[0]!.id, estado: "DISPONIBLE", delta: -999999 } })).rejects.toThrow(/por debajo de cero/);
  });

  it("criterio 3: ofrece una salida parcial por lo disponible, que queda marcada y exige autorización", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [6], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 9 }], { aceptarParcial: true });
    expect(s).toMatchObject({ parcial: true, estado: "SOLICITADA", cantidad: 6 });
    expect(s.detalle[0]).toMatchObject({ cantidad: 6, cantidadPedida: 9 });
    expect((await autorizar(s.id, coord)).statusCode).toBe(403); // previa autorización del Jefe
    expect((await autorizar(s.id)).statusCode).toBe(200);
    // Con nada disponible no hay salida parcial posible.
    expect((await pedirSalida([{ skuId: e.skus[1]!.id, cantidad: 1 }], { aceptarParcial: true })).statusCode).toBe(409);
  });
});

describe("HU-SAL-002 · reservar la existencia al autorizar la salida", () => {
  it("criterios 1 y 2: al autorizar la cantidad pasa a reservada y deja de contar como disponible", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10, 20], e.ubicaciones[0]!.id);
    const refId = await refDe(e.skus[0]!);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 12 }]);
    const a = await autorizar(s.id);
    expect(a.statusCode, a.body).toBe(200);
    const v = json<SalidaVista>(a);
    expect(v).toMatchObject({ estado: "AUTORIZADA", autorizadaPor: "jefe" });
    expect(v.venceEn).not.toBeNull();
    expect(v.reservas.reduce((x, r) => x + r.cantidad, 0)).toBe(12);
    const ex = await existencia(refId);
    expect(ex.porEstado).toMatchObject({ DISPONIBLE: 18, RESERVADO: 12 });
    expect(ex.total).toBe(30);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { salidaId: s.id, tipo: "RESERVA" }, include: { asientos: true } });
    expect(mov.asientos.reduce((x, y) => x + Number(y.delta), 0)).toBe(0); // reservar redistribuye, no cambia el total
  });

  it("criterio 3: otra operación sobre la misma existencia se rechaza (otra salida, o mover la pieza)", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 10 }]);
    await autorizar(s.id);
    const otra = await pedirSalida([{ skuId: e.skus[0]!.id, cantidad: 1 }]);
    expect(otra.statusCode).toBe(409);
    expect(otra.json().error).toContain("No hay existencia disponible");
    const mover = await pedir(app, aux1, "POST", "/api/movimientos/internos", { piezaId: st.piezas[0]!.id, destinoId: e.ubicaciones[1]!.id });
    expect(mover.statusCode).toBe(409);
    expect(mover.json().error).toMatch(/reservada|no está disponible/);
  });

  it("dos autorizaciones simultáneas sobre la misma existencia: solo una se aplica", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const a = await salida([{ skuId: e.skus[0]!.id, cantidad: 8 }]);
    const b = await salida([{ skuId: e.skus[0]!.id, cantidad: 8 }]);
    const [ra, rb] = await Promise.all([autorizar(a.id), autorizar(b.id, admin)]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const refId = await refDe(e.skus[0]!);
    expect((await existencia(refId)).porEstado).toMatchObject({ DISPONIBLE: 2, RESERVADO: 8 });
  });

  it("criterio 4: la reserva se libera al cancelar", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const refId = await refDe(e.skus[0]!);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 7 }]);
    await autorizar(s.id);
    expect((await existencia(refId)).porEstado.RESERVADO).toBe(7);
    // El Auxiliar no cancela; el Jefe sí.
    expect((await cancelar(s.id, aux1)).statusCode).toBe(403);
    const c = await cancelar(s.id);
    expect(c.statusCode).toBe(200);
    expect(json<SalidaVista>(c).estado).toBe("CANCELADA");
    expect((await existencia(refId)).porEstado).toMatchObject({ DISPONIBLE: 10, RESERVADO: 0 });
    expect((await cancelar(s.id)).statusCode).toBe(409); // ya cancelada
    expect((await autorizar(s.id)).statusCode).toBe(409);
  });

  it("criterio 4 (RN-SAL-005): la reserva que no se ejecuta en su plazo se libera sola y queda en la bitácora", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const refId = await refDe(e.skus[0]!);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 10 }]);
    await autorizar(s.id);
    await prisma.salida.update({ where: { id: s.id }, data: { venceEn: new Date(Date.now() - 1000) } });
    const v = await ver(s.id); // consultar libera las vencidas
    expect(v.estado).toBe("VENCIDA");
    expect((await existencia(refId)).porEstado).toMatchObject({ DISPONIBLE: 10, RESERVADO: 0 });
    const evento = await prisma.registroBitacora.findFirst({ where: { evento: "reserva_liberada_por_vencimiento", entidadId: s.id } });
    expect(evento).toMatchObject({ actorTipo: "SISTEMA" });
    expect((await confirmar(s.id)).json().error).toContain("venció");
    expect((await tomar(s.id, { mercanciaCodigo: "x", piezaId: "y" })).json().error).toContain("venció");
  });

  it("solo el Jefe y el Administrador autorizan (el umbral del Coordinador queda fuera del corte)", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 1 }]);
    for (const t of [coord, aux1, auditor]) expect((await autorizar(s.id, t)).statusCode).toBe(403);
    expect((await autorizar(s.id, admin)).statusCode).toBe(200);
  });
});

describe("HU-SAL-003 · ubicación de toma y validación del escaneo al preparar", () => {
  it("criterio 1 (RN-SAL-003): indica ubicación y cantidad por línea, primero en entrar primero en salir (política 1)", async () => {
    const e = await escenario();
    const viejo = await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    await new Promise((r) => setTimeout(r, 30));
    const nuevo = await stock(e.skus[0]!, [10], e.ubicaciones[1]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 10 }]);
    const v = json<SalidaVista>(await autorizar(s.id));
    expect(v.reservas).toHaveLength(1);
    expect(v.reservas[0]).toMatchObject({ ubicacion: e.ubicaciones[0]!.codigo, cantidad: 10, pieza: viejo.piezas[0]!.numero });
    expect(nuevo.loteId).not.toBe(viejo.loteId);
  });

  it("política 2: la ubicación de mayor cantidad", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [5], e.ubicaciones[0]!.id);
    await stock(e.skus[0]!, [25], e.ubicaciones[1]!.id);
    expect((await pedir(app, admin, "PUT", "/api/parametros/politica_toma", { valor: 2 })).statusCode).toBe(200);
    try {
      const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 20 }]);
      const v = json<SalidaVista>(await autorizar(s.id));
      expect(v.reservas.map((r) => [r.ubicacion, r.cantidad])).toEqual([[e.ubicaciones[1]!.codigo, 20]]);
    } finally {
      await pedir(app, admin, "PUT", "/api/parametros/politica_toma", { valor: 1 });
    }
  });

  it("criterios 2, 4 y 5: escanea y selecciona cada pieza, el progreso es visible y confirma al completar", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10, 12], e.ubicaciones[0]!.id);
    const refId = await refDe(e.skus[0]!);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 22 }]);
    const a = json<SalidaVista>(await autorizar(s.id));
    expect(a.reservas).toHaveLength(2);
    expect(a.detalle[0]).toMatchObject({ tomada: 0, piezasTomadas: 0, piezasReservadas: 2 });

    const t1 = await tomar(s.id, { mercanciaCodigo: st.qr.toLowerCase(), piezaId: st.piezas[0]!.id });
    expect(t1.statusCode).toBe(201);
    expect(json<TomaResultado>(t1)).toMatchObject({ yaContada: false, cantidad: 10, corte: false });
    expect(json<TomaResultado>(t1).salida.detalle[0]).toMatchObject({ tomada: 10, piezasTomadas: 1, piezasReservadas: 2 });

    // Incompleta: no se confirma y se explica qué falta.
    const incompleta = await confirmar(s.id);
    expect(incompleta.statusCode).toBe(409);
    expect(incompleta.json().error).toContain("incompleta");
    expect(incompleta.json().error).toContain("tomado 10 de 22");

    expect((await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[1]!.id })).statusCode).toBe(201);
    expect((await ver(s.id)).completa).toBe(true);
    const c = await confirmar(s.id);
    expect(c.statusCode, c.body).toBe(200);
    expect(json<SalidaVista>(c)).toMatchObject({ estado: "CONFIRMADA", confirmadaPor: "auxiliar1" });
    const ex = await existencia(refId);
    expect(ex.total).toBe(0);
    expect(ex.porEstado.RESERVADO).toBe(0);
  });

  it("criterio 3 (RN-SAL-004): un escaneo que no corresponde se rechaza explicando la discrepancia (talla, lote)", async () => {
    const e = await escenario();
    const pedido = await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const otraTalla = await stock(e.skus[1]!, [10], e.ubicaciones[1]!.id);
    const otroLote = await stock(e.skus[0]!, [10], e.ubicaciones[2]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, loteId: pedido.loteId, cantidad: 10 }]);
    await autorizar(s.id);

    const talla = await tomar(s.id, { mercanciaCodigo: otraTalla.qr, piezaId: otraTalla.piezas[0]!.id });
    expect(talla.statusCode).toBe(409);
    expect(talla.json()).toMatchObject({ discrepancia: true });
    expect(talla.json().error).toContain("talla");
    expect(talla.json().error).toContain(e.skus[0]!.talla);
    const lote = await tomar(s.id, { mercanciaCodigo: otroLote.qr, piezaId: otroLote.piezas[0]!.id });
    expect(lote.statusCode).toBe(409);
    expect(lote.json().error).toContain("lote");
    const pieza = await tomar(s.id, { mercanciaCodigo: pedido.qr, piezaId: otroLote.piezas[0]!.id });
    expect(pieza.json().error).toContain("no es del lote escaneado");
    expect((await tomar(s.id, { mercanciaCodigo: "COL-M-NOEXISTE-00000", piezaId: pedido.piezas[0]!.id })).json()).toMatchObject({ ofrecerNovedad: true });
    expect(await prisma.registroBitacora.count({ where: { evento: "escaneo_salida_rechazado", entidadId: s.id } })).toBeGreaterThanOrEqual(2);
    expect((await tomar(s.id, {})).json().error).toContain("Escanee"); // mensajes claros, nunca «Required»
  });
});

describe("HU-SAL-008 · el escaneo de salida verifica y cuenta las piezas tomadas", () => {
  it("criterio 2 (RN-SAL-009): cada pieza se cuenta una sola vez; seleccionar de nuevo la misma no suma", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10, 10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 20 }]);
    await autorizar(s.id);
    const primera = await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id });
    const repetida = await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id });
    expect(primera.statusCode).toBe(201);
    expect(repetida.statusCode).toBe(200);
    expect(json<TomaResultado>(repetida)).toMatchObject({ yaContada: true });
    expect(json<TomaResultado>(repetida).salida.detalle[0]).toMatchObject({ tomada: 10, piezasTomadas: 1 });
    expect(await prisma.tomaSalida.count({ where: { reserva: { linea: { salidaId: s.id } } } })).toBe(1);
  });

  it("criterios 3 y 4: el progreso muestra lo tomado frente a lo solicitado y no se confirma completa si falta, salvo parcial autorizada", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10, 5], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 20 }], { aceptarParcial: true }); // solo hay 15
    expect(s.parcial).toBe(true);
    await autorizar(s.id);
    expect((await confirmar(s.id)).json().error).toContain("ninguna pieza"); // parcial, pero sin tomar nada
    await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id });
    const v = await ver(s.id);
    expect(v.detalle[0]).toMatchObject({ cantidad: 15, cantidadPedida: 20, tomada: 10 });
    const refId = await refDe(e.skus[0]!);
    // Parcial autorizada: se confirma lo tomado y lo reservado no tomado vuelve a disponible.
    const c = await confirmar(s.id);
    expect(c.statusCode, c.body).toBe(200);
    expect((await existencia(refId)).porEstado).toMatchObject({ DISPONIBLE: 5, RESERVADO: 0 });
  });

  it("criterio 5: cada pieza tomada queda en el kardex dentro del movimiento de salida, con motivo, autorización y atribución", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10, 12], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 22 }]);
    await autorizar(s.id);
    for (const p of st.piezas) await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: p.id });
    expect((await confirmar(s.id)).statusCode).toBe(200);
    const k = json<KardexVista>(await pedir(app, auditor, "GET", `/api/inventario/kardex?loteId=${st.loteId}`));
    const salidas = k.lineas.filter((l) => l.tipo === "SALIDA");
    expect(salidas.map((l) => [l.pieza, l.cantidad]).sort()).toEqual(st.piezas.map((p) => [p.numero, -p.cantidad]).sort());
    expect(salidas.every((l) => l.salida === s.numero && l.motivo === "Despacho" && l.usuario === "auxiliar1" && l.estado === "RESERVADO")).toBe(true);
    expect(k.lineas.some((l) => l.tipo === "RESERVA" && l.usuario === "jefe")).toBe(true); // la autorización queda atribuida
    expect(k.existenciaFinal).toBe(0);
    const bit = await prisma.registroBitacora.findFirst({ where: { evento: "salida_confirmada", entidadId: s.id } });
    expect(bit!.detalle).toMatchObject({ autorizadaPor: "jefe", piezas: 2 });
  });
});

describe("HU-SAL-009 · registrar el corte parcial de un rollo", () => {
  it("criterios 1, 3, 4, 5 y 6: se corta una parte, la pieza conserva su identidad y su remanente, y queda en el kardex", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [30], e.ubicaciones[0]!.id);
    const p = st.piezas[0]!;
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 8 }], { observacion: "Corte para muestra" });
    const a = json<SalidaVista>(await autorizar(s.id));
    expect(a.reservas[0]).toMatchObject({ pieza: p.numero, cantidad: 8, piezaTotal: 30 });

    const t = await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: p.id });
    expect(json<TomaResultado>(t)).toMatchObject({ cantidad: 8, corte: true, restante: 22 }); // visible de inmediato
    expect((await confirmar(s.id)).statusCode).toBe(200);

    const lote = json<{ piezas: Array<{ id: string; numero: number; cantidad: number; cantidadActual: number; ubicaciones: Array<{ estado: string; cantidad: number; ubicacion: string }> }> }>(await pedir(app, jefe, "GET", `/api/inventario/lotes/${st.loteId}/piezas`));
    expect(lote.piezas).toHaveLength(1);
    expect(lote.piezas[0]).toMatchObject({ id: p.id, numero: p.numero, cantidad: 30, cantidadActual: 22 }); // misma pieza, con su remanente
    expect(lote.piezas[0]!.ubicaciones).toEqual([expect.objectContaining({ estado: "DISPONIBLE", cantidad: 22, ubicacion: e.ubicaciones[0]!.codigo })]);
    const k = json<KardexVista>(await pedir(app, jefe, "GET", `/api/inventario/kardex?piezaId=${p.id}`));
    const corte = k.lineas.find((l) => l.tipo === "SALIDA")!;
    expect(corte).toMatchObject({ cantidad: -8, pieza: p.numero, usuario: "auxiliar1", motivo: "Despacho", salida: s.numero });
  });

  it("criterio 2: la cantidad cortada no puede superar la de la pieza ni lo reservado", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [30], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 8 }]);
    await autorizar(s.id);
    const masQuePieza = await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id, cantidad: 31 });
    expect(masQuePieza.statusCode).toBe(409);
    expect(masQuePieza.json().error).toContain("no puede superar la de la pieza");
    const masQueReservado = await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id, cantidad: 9 });
    expect(masQueReservado.statusCode).toBe(409);
    expect(masQueReservado.json().error).toContain("Solo se reservaron 8");
    expect((await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id, cantidad: 0 })).statusCode).toBe(422);
    expect((await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id, cantidad: 2.5 })).statusCode).toBe(422);
    // Un corte menor que lo reservado deja la salida incompleta: no se confirma sin parcial autorizada.
    expect((await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id, cantidad: 5 })).statusCode).toBe(201);
    expect((await confirmar(s.id)).statusCode).toBe(409);
  });

  it("una pieza reservada en parte no se puede mover (sería dividirla)", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [30], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 8 }]);
    await autorizar(s.id);
    const r = await pedir(app, aux1, "POST", "/api/movimientos/internos", { piezaId: st.piezas[0]!.id, destinoId: e.ubicaciones[1]!.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("reservada");
  });
});

describe("Salidas · integridad y consulta", () => {
  it("las reservas y salidas no se anulan: se cancelan; lo que salió solo vuelve como entrada nueva (RN-SAL-007)", async () => {
    const e = await escenario();
    const st = await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 10 }]);
    await autorizar(s.id);
    await tomar(s.id, { mercanciaCodigo: st.qr, piezaId: st.piezas[0]!.id });
    await confirmar(s.id);
    const anulacion = json<Array<{ id: string; tipoOperacion: string }>>(await pedir(app, jefe, "GET", "/api/motivos")).find((m) => m.tipoOperacion === "ANULACION")!;
    for (const tipo of ["RESERVA", "SALIDA"] as const) {
      const mov = await prisma.movimiento.findFirstOrThrow({ where: { salidaId: s.id, tipo } });
      const r = await pedir(app, jefe, "POST", `/api/inventario/movimientos/${mov.id}/anular`, { motivoId: anulacion.id });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toContain("no se anulan");
    }
  });

  it("la base exige que una salida lleve su motivo y su documento (restricción de coherencia del movimiento)", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 1 }]);
    const u = await prisma.usuario.findFirstOrThrow();
    const base = { usuarioId: u.id, usuarioLogin: "x", iniciadoEn: new Date() };
    await expect(prisma.movimiento.create({ data: { ...base, tipo: "SALIDA", salidaId: s.id } })).rejects.toThrow(/origen_coherente/); // sin motivo
    await expect(prisma.movimiento.create({ data: { ...base, tipo: "RESERVA" } })).rejects.toThrow(/origen_coherente/); // sin salida
    await expect(prisma.movimiento.create({ data: { ...base, tipo: "ENTRADA", motivoId: motivo.id } })).rejects.toThrow(/origen_coherente/);
  });

  it("la lista y el detalle se consultan por todos los roles, y filtran por estado", async () => {
    const e = await escenario();
    await stock(e.skus[0]!, [10], e.ubicaciones[0]!.id);
    const s = await salida([{ skuId: e.skus[0]!.id, cantidad: 2 }]);
    for (const t of [admin, jefe, coord, aux1, auditor]) expect((await pedir(app, t, "GET", `/api/salidas/${s.id}`)).statusCode).toBe(200);
    const solicitadas = json<Array<{ id: string }>>(await pedir(app, auditor, "GET", "/api/salidas?estado=SOLICITADA"));
    expect(solicitadas.some((x) => x.id === s.id)).toBe(true);
    expect((await pedir(app, jefe, "GET", "/api/salidas/no-existe")).statusCode).toBe(404);
    expect((await pedir(app, auditor, "POST", `/api/salidas/${s.id}/confirmar`)).statusCode).toBe(403);
  });
});
