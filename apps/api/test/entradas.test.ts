import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista, DesviacionVista, DocumentoEntradaVista, IdentificadorResumen, LoteVista, PropuestaUbicacion, SkuVista } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string, jefe: string, coord: string, aux1: string, aux2: string, auditor: string;
let skus: SkuVista[];
let bodega: BodegaVista;
const unidades = () => skus.filter((s) => s.unidadMedida === "UNIDADES" && s.referencia.startsWith("PRE"));

beforeAll(async () => {
  app = await iniciarApp();
  [admin, jefe, coord, aux1, aux2, auditor] = await Promise.all(["admin", "jefe", "coordinador", "auxiliar1", "auxiliar2", "auditor"].map((l) => entrar(app, l)));
  skus = (await pedir(app, coord, "GET", "/api/lotes/skus")).json() as SkuVista[];
  bodega = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[])[0]!;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---- ayudas ----
const hoy = () => new Date().toISOString().slice(0, 10);
const crearDoc = (lineas: Array<{ sku: SkuVista; cantidad: number }>, extra: object = {}, token = coord) =>
  pedir(app, token, "POST", "/api/entradas", { bodegaId: bodega.id, origen: unico("Origen "), fechaEsperada: hoy(), lineas: lineas.map((l) => ({ skuId: l.sku.id, cantidad: l.cantidad })), ...extra });
const doc = async (lineas: Array<{ sku: SkuVista; cantidad: number }>, extra: object = {}) => (await crearDoc(lineas, extra)).json() as DocumentoEntradaVista;
const ver = async (id: string) => (await pedir(app, coord, "GET", `/api/entradas/${id}`)).json() as DocumentoEntradaVista;
const pieza = (d: DocumentoEntradaVista, i: number, cantidad: number, tipo = "PAQUETE", token = aux1) =>
  pedir(app, token, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[i]!.id, tipo, cantidad });
const cerrar = (d: DocumentoEntradaVista, token = aux1) => pedir(app, token, "POST", `/api/entradas/${d.id}/cerrar-recepcion`);
const confirmar = (d: DocumentoEntradaVista, lotes: object[] | null = null, token = jefe) =>
  pedir(app, token, "POST", `/api/entradas/${d.id}/confirmar`, { lotes: lotes ?? d.detalle.filter((l) => l.piezas.length > 0).map((l) => ({ lineaId: l.id, codigo: unico("LT") })) });

/** Documento recibido por el Auxiliar y confirmado por el Jefe: la pieza queda EN RECEPCION. */
async function entradaConfirmada(sku: SkuVista, cantidad = 10, tipo = "PAQUETE") {
  let d = await doc([{ sku, cantidad }]);
  const r = await pieza(d, 0, cantidad, tipo);
  expect(r.statusCode).toBe(201);
  d = r.json() as DocumentoEntradaVista;
  const c = await confirmar(d);
  expect(c.statusCode).toBe(200);
  return c.json() as DocumentoEntradaVista;
}
const ubicar = (piezaId: string, cuerpo: object, token = aux1) => pedir(app, token, "POST", `/api/entradas/piezas/${piezaId}/ubicar`, cuerpo);
const propuesta = async (piezaId: string) => (await pedir(app, aux1, "GET", `/api/entradas/piezas/${piezaId}/propuesta`)).json() as PropuestaUbicacion;
const idUbicacion = (codigo: string) => bodega.zonas.flatMap((z) => z.ubicaciones).find((u) => u.codigo === codigo)!.id;
const zonaDe = (codigo: string) => bodega.zonas.find((z) => z.codigo === codigo)!;

/** Una categoría con su propia zona y ubicaciones, y una referencia en unidades: aísla la propuesta del resto de las pruebas. */
async function escenario(capacidades: Array<number | null>) {
  const categoria = (await pedir(app, jefe, "POST", "/api/catalogo/categorias", { nombre: unico("Cat") })).json() as { id: string };
  const zona = (await pedir(app, admin, "POST", `/api/bodega/bodegas/${bodega.id}/zonas`, { codigo: unico("Z").slice(0, 12).toUpperCase(), nombre: "Zona de prueba", tipo: "ALMACENAMIENTO" })).json() as { id: string };
  expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${zona.id}/categoria`, { categoriaId: categoria.id })).statusCode).toBe(200);
  const ubicaciones: Array<{ id: string; codigo: string }> = [];
  for (const [i, cap] of capacidades.entries()) {
    const codigo = (unico("U").slice(0, 14) + i).toUpperCase();
    const r = await pedir(app, admin, "POST", `/api/bodega/zonas/${zona.id}/ubicaciones`, { codigo, ...(cap === null ? {} : { capacidad: cap, unidadCapacidad: "UNIDADES" }) });
    ubicaciones.push({ id: (r.json() as { id: string }).id, codigo });
  }
  const tallaIds = ((await pedir(app, jefe, "GET", "/api/catalogo/tallas")).json() as Array<{ id: string }>).slice(0, 1).map((t) => t.id);
  const colorIds = ((await pedir(app, jefe, "GET", "/api/catalogo/colores")).json() as Array<{ id: string }>).slice(0, 1).map((t) => t.id);
  const ref = (await pedir(app, jefe, "POST", "/api/catalogo/referencias", { codigo: unico("RX"), descripcion: "Referencia aislada", categoriaId: categoria.id, unidadMedida: "UNIDADES", tallaIds, colorIds })).json() as { id: string };
  const todos = (await pedir(app, coord, "GET", "/api/lotes/skus")).json() as SkuVista[];
  const propio = await prisma.sku.findFirstOrThrow({ where: { referenciaId: ref.id } });
  return { categoriaId: categoria.id, zonaId: zona.id, ubicaciones, sku: todos.find((s) => s.id === propio.id)! };
}

describe("HU-ENT-001 · crear el documento de entrada con lo esperado", () => {
  it("criterios 1 y 3: registra origen, fecha esperada y líneas, y queda pendiente de recepción", async () => {
    const r = await crearDoc([{ sku: unidades()[0]!, cantidad: 40 }, { sku: unidades()[1]!, cantidad: 15 }], { origen: unico("Taller "), fechaEsperada: "2026-11-05" });
    expect(r.statusCode).toBe(201);
    const d = r.json() as DocumentoEntradaVista;
    expect(d).toMatchObject({ fechaEsperada: "2026-11-05", estado: "PENDIENTE_RECEPCION", lineas: 2, bodega: bodega.codigo, creadoPor: "coordinador" });
    expect(d.detalle.map((l) => l.cantidadEsperada).sort()).toEqual([15, 40]);
    expect(d.detalle.every((l) => l.resultado === "SIN_RECIBIR" && l.cantidadRecibida === 0)).toBe(true);
    expect(await prisma.registroBitacora.count({ where: { evento: "entrada_creada", entidadId: d.id } })).toBe(1);
  });

  it("criterio 2 (DC-03): no pide ni guarda precio, condiciones comerciales ni orden de compra", async () => {
    const r = await crearDoc([{ sku: unidades()[0]!, cantidad: 5 }], { precio: 1000, ordenCompra: "OC-1", condiciones: "30 días" });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toMatch(/precio|orden.?compra|condicion|costo/i);
    const columnas = (await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name IN ('DocumentoEntrada','LineaEntrada')`).map((c) => c.column_name);
    expect(columnas.join(" ")).not.toMatch(/precio|compra|costo|condicion/i);
  });

  it("criterio 4 (RN-ENT-002): advierte de un posible duplicado y exige confirmación explícita, sin bloquearlo", async () => {
    const origen = unico("Proveedor ");
    const base = { origen, fechaEsperada: "2026-12-01" };
    const primero = (await crearDoc([{ sku: unidades()[2]!, cantidad: 5 }], base)).json() as DocumentoEntradaVista;
    const dup = await crearDoc([{ sku: unidades()[2]!, cantidad: 9 }], { ...base, origen: origen.toUpperCase() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ codigo: "POSIBLE_DUPLICADO", duplicados: [{ id: primero.id, numero: primero.numero }] });
    expect((await crearDoc([{ sku: unidades()[2]!, cantidad: 9 }], { ...base, confirmarDuplicado: true })).statusCode).toBe(201);
    // Otra fecha u otra referencia no es duplicado.
    expect((await crearDoc([{ sku: unidades()[2]!, cantidad: 9 }], { ...base, fechaEsperada: "2026-12-02" })).statusCode).toBe(201);
    expect((await crearDoc([{ sku: skus.find((s) => s.referencia.startsWith("INS"))!, cantidad: 9 }], base)).statusCode).toBe(201);
  });

  it("valida: solo referencias activas (RN-ENT-001), cantidades en la unidad de la referencia (RN-INT-007), un SKU por línea y roles", async () => {
    const sku = unidades()[3]!;
    expect((await crearDoc([])).statusCode).toBe(422);
    expect((await crearDoc([{ sku, cantidad: 0 }])).statusCode).toBe(422);
    expect((await crearDoc([{ sku, cantidad: 2.5 }])).json().error).toContain("enteros");
    expect((await crearDoc([{ sku, cantidad: 1 }, { sku, cantidad: 2 }])).statusCode).toBe(422);
    const metros = skus.find((s) => s.referencia.startsWith("TEL") && s.unidadMedida === "METROS")!;
    expect((await crearDoc([{ sku: metros, cantidad: 12.345 }])).statusCode).toBe(201);
    expect((await crearDoc([{ sku: metros, cantidad: 12.3456 }])).statusCode).toBe(422);
    expect((await crearDoc([{ sku, cantidad: 1 }], { fechaEsperada: "05/11/2026" })).statusCode).toBe(422);
    expect((await crearDoc([{ sku, cantidad: 1 }], { bodegaId: "no-existe" })).statusCode).toBe(404);

    const ref = await prisma.referencia.findFirstOrThrow({ where: { skus: { some: { id: sku.id } } } });
    await prisma.referencia.update({ where: { id: ref.id }, data: { activa: false } });
    try { expect((await crearDoc([{ sku, cantidad: 1 }])).statusCode).toBe(422); }
    finally { await prisma.referencia.update({ where: { id: ref.id }, data: { activa: true } }); }

    expect((await crearDoc([{ sku, cantidad: 1 }], {}, aux1)).statusCode).toBe(403);
    expect((await crearDoc([{ sku, cantidad: 1 }], {}, auditor)).statusCode).toBe(403);
  });
});

describe("HU-ENT-002 y HU-ENT-009 · registrar lo que se recibe, pieza por pieza", () => {
  it("HU-ENT-009 criterios 1 y 3: cada pieza lleva tipo y cantidad propia; la cantidad de la línea es la suma de sus piezas", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 100 }]);
    d = (await pieza(d, 0, 30)).json() as DocumentoEntradaVista;
    d = (await pieza(d, 0, 20, "BOLSA")).json() as DocumentoEntradaVista;
    expect(d.detalle[0]).toMatchObject({ cantidadRecibida: 50, resultado: "EN_CURSO" });
    expect(d.detalle[0]!.piezas.map((p) => [p.tipo, p.cantidad])).toEqual([["PAQUETE", 30], ["BOLSA", 20]]);
    expect(d.estado).toBe("RECEPCION_PARCIAL");
  });

  it("HU-ENT-009 criterio 1: el tipo depende de la unidad (rollo para metros y kilos; paquete o bolsa para unidades)", async () => {
    const metros = skus.find((s) => s.referencia.startsWith("TEL") && s.unidadMedida === "METROS")!;
    const kilos = skus.find((s) => s.referencia.startsWith("TEL") && s.unidadMedida === "KILOGRAMOS")!;
    const dm = await doc([{ sku: metros, cantidad: 100 }, { sku: kilos, cantidad: 50 }, { sku: unidades()[0]!, cantidad: 10 }]);
    const idx = (s: SkuVista) => dm.detalle.findIndex((l) => l.sku.id === s.id);
    expect((await pieza(dm, idx(metros), 40, "PAQUETE")).statusCode).toBe(422);
    expect((await pieza(dm, idx(metros), 40.5, "ROLLO")).statusCode).toBe(201);
    expect((await pieza(dm, idx(kilos), 25.25, "ROLLO")).statusCode).toBe(201);
    expect((await pieza(dm, idx(unidades()[0]!), 5, "ROLLO")).statusCode).toBe(422);
    expect((await pieza(dm, idx(unidades()[0]!), 5.5, "PAQUETE")).statusCode).toBe(422);
    expect((await pieza(dm, idx(unidades()[0]!), 0, "PAQUETE")).statusCode).toBe(422);
  });

  it("HU-ENT-009 criterio 2: la pieza pertenece a una sola línea (un solo SKU + Lote), y solo a la de su documento", async () => {
    const a = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    const b = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    const r = await pedir(app, aux1, "POST", `/api/entradas/${a.id}/piezas`, { lineaId: b.detalle[0]!.id, tipo: "PAQUETE", cantidad: 5 });
    expect(r.statusCode).toBe(404);
    const creada = ((await pieza(a, 0, 5)).json() as DocumentoEntradaVista).detalle[0]!.piezas[0]!;
    const col = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'Pieza'`;
    expect(col.map((c) => c.column_name)).toContain("lineaId"); // una columna: no puede apuntar a dos líneas
    expect(creada.numero).toBeGreaterThan(0); // HU-ENT-009 criterio 4: identidad interna, distinta del QR
  });

  it("HU-ENT-002 criterio 4 (RF-ENT-006): la recepción la continúa otro usuario y quedan registrados ambos", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 100 }]);
    d = (await pieza(d, 0, 40, "PAQUETE", aux1)).json() as DocumentoEntradaVista;
    d = (await pieza(d, 0, 60, "PAQUETE", aux2)).json() as DocumentoEntradaVista;
    expect(d.receptores).toEqual(["auxiliar1", "auxiliar2"]);
    expect(d.detalle[0]!.piezas.map((p) => p.registradaPor)).toEqual(["auxiliar1", "auxiliar2"]);
    expect(await prisma.registroBitacora.count({ where: { evento: "recepcion_continuada_por_otro_usuario", entidadId: d.id } })).toBe(1);
  });

  it("RF-ENT-017: queda el instante de llegada, y el documento pasa a conforme cuando todo coincide", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    expect(d.llegadaEn).toBeNull();
    d = (await pieza(d, 0, 4)).json() as DocumentoEntradaVista;
    expect(Math.abs(new Date(d.llegadaEn!).getTime() - Date.now())).toBeLessThan(15_000);
    const llegada = d.llegadaEn;
    d = (await pieza(d, 0, 6)).json() as DocumentoEntradaVista;
    expect(d.llegadaEn).toBe(llegada);
    expect(d.estado).toBe("RECIBIDO_CONFORME");
    expect(d.detalle[0]).toMatchObject({ resultado: "CONFORME", diferencia: 0 });
    // Con la recepción cerrada ya no se registran más piezas.
    expect((await pieza(d, 0, 1)).statusCode).toBe(409);
  });

  it("solo quien opera la recepción la registra: el Auditor no", async () => {
    const d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    expect((await pieza(d, 0, 5, "PAQUETE", auditor)).statusCode).toBe(403);
    expect((await pedir(app, aux1, "POST", `/api/entradas/${d.id}/piezas`, { lineaId: d.detalle[0]!.id })).statusCode).toBe(422);
    expect((await pedir(app, aux1, "POST", "/api/entradas/no-existe/piezas", { lineaId: "x", tipo: "BOLSA", cantidad: 1 })).statusCode).toBe(404);
  });
});

describe("HU-ENT-004 · ver la diferencia entre lo esperado y lo recibido", () => {
  it("criterios 1 y 4: compara línea por línea y marca recibido conforme cuando coincide", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }, { sku: unidades()[1]!, cantidad: 8 }]);
    d = (await pieza(d, 0, 10)).json() as DocumentoEntradaVista;
    const por = Object.fromEntries(d.detalle.map((l) => [l.sku.id, l.resultado]));
    expect(por[unidades()[0]!.id]).toBe("CONFORME");
    expect(por[unidades()[1]!.id]).toBe("SIN_RECIBIR");
  });

  it("criterio 2 (RN-ENT-004): un faltante se registra, el documento queda con novedad y el hecho queda para el Jefe; no impide confirmar lo recibido", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 20 }]);
    d = (await pieza(d, 0, 15)).json() as DocumentoEntradaVista;
    expect(d.estado).toBe("RECEPCION_PARCIAL");
    const c = await cerrar(d);
    expect(c.statusCode).toBe(200);
    d = c.json() as DocumentoEntradaVista;
    expect(d).toMatchObject({ estado: "RECIBIDO_CON_NOVEDAD", tieneFaltante: true, tieneSobrante: false });
    expect(d.detalle[0]).toMatchObject({ resultado: "FALTANTE", diferencia: -5, cantidadRecibida: 15 });
    expect(await prisma.registroBitacora.count({ where: { evento: "faltante_recepcion", detalle: { path: ["documento"], equals: d.numero } } })).toBe(1);
    expect((await confirmar(d)).statusCode).toBe(200); // el faltante no bloquea
  });

  it("criterio 3 (RN-ENT-005): el sobrante se marca al registrarlo y exige autorización del Jefe antes de confirmar", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    d = (await pieza(d, 0, 12)).json() as DocumentoEntradaVista;
    expect(d.detalle[0]!.resultado).toBe("SOBRANTE");
    expect(await prisma.registroBitacora.count({ where: { evento: "sobrante_detectado", detalle: { path: ["documento"], equals: d.numero } } })).toBe(1);
    d = (await cerrar(d)).json() as DocumentoEntradaVista;
    expect(d).toMatchObject({ estado: "RECIBIDO_CON_NOVEDAD", tieneSobrante: true });
    expect(d.detalle[0]!.diferencia).toBe(2);

    const sin = await confirmar(d, null, coord);
    expect(sin.statusCode).toBe(409);
    expect(sin.json().error).toContain("autorizarlo");
    expect((await pedir(app, coord, "POST", `/api/entradas/${d.id}/autorizar-sobrante`)).statusCode).toBe(403);
    expect((await pedir(app, aux1, "POST", `/api/entradas/${d.id}/autorizar-sobrante`)).statusCode).toBe(403);
    const aut = await pedir(app, jefe, "POST", `/api/entradas/${d.id}/autorizar-sobrante`);
    expect(aut.statusCode).toBe(200);
    expect((aut.json() as DocumentoEntradaVista).sobranteAutorizado?.por).toBe("jefe");
    expect((await pedir(app, jefe, "POST", `/api/entradas/${d.id}/autorizar-sobrante`)).statusCode).toBe(409);
    expect((await confirmar(d, null, coord)).statusCode).toBe(200);
  });

  it("no se autoriza un sobrante que no existe, ni antes de cerrar la recepción", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    d = (await pieza(d, 0, 12)).json() as DocumentoEntradaVista;
    expect((await pedir(app, jefe, "POST", `/api/entradas/${d.id}/autorizar-sobrante`)).statusCode).toBe(409);
    let f = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    f = (await pieza(f, 0, 6)).json() as DocumentoEntradaVista;
    f = (await cerrar(f)).json() as DocumentoEntradaVista;
    expect((await pedir(app, jefe, "POST", `/api/entradas/${f.id}/autorizar-sobrante`)).statusCode).toBe(409);
  });

  it("criterio 5: la diferencia queda registrada en el documento; cerrar dos veces o sin piezas se maneja", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }, { sku: unidades()[1]!, cantidad: 10 }]);
    d = (await pieza(d, 0, 10)).json() as DocumentoEntradaVista;
    d = (await cerrar(d)).json() as DocumentoEntradaVista;
    const reabierto = await ver(d.id);
    expect(reabierto.detalle.map((l) => l.diferencia).sort()).toEqual([-10, 0]);
    expect((await cerrar(d)).statusCode).toBe(409);
    // Una recepción sin ninguna pieza se cierra como faltante total, pero no hay nada que confirmar.
    const vacio = (await cerrar(await doc([{ sku: unidades()[0]!, cantidad: 3 }]))).json() as DocumentoEntradaVista;
    expect(vacio.detalle[0]).toMatchObject({ resultado: "FALTANTE", diferencia: -3 });
    expect((await confirmar(vacio, [])).json().error).toContain("No hay piezas");
  });
});

describe("HU-ENT-003 y HU-LOT-001 · confirmar la entrada por una segunda persona", () => {
  it("criterio 1 (RN-ENT-007): quien registró la recepción física no puede confirmar la misma entrada", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    d = (await pieza(d, 0, 10, "PAQUETE", coord)).json() as DocumentoEntradaVista; // el Coordinador también puede recibir
    const r = await confirmar(d, null, coord);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("otra persona");
    expect((await confirmar(d, null, jefe)).statusCode).toBe(200);
  });

  it("criterios 2 a 4: genera el movimiento de entrada, la existencia queda EN RECEPCION (no disponible) y se crea el lote", async () => {
    const sku = unidades()[4]!;
    const d = await entradaConfirmada(sku, 25);
    expect(d).toMatchObject({ estado: "CONFIRMADO", confirmado: { por: "jefe" } });
    expect(d.ubicacionRecepcion).toMatch(/^REC-/);
    const p = d.detalle[0]!.piezas[0]!;
    // RN-EXI-007: en una ubicación de la zona de recepción, en recepción y no disponible.
    expect(p.ubicaciones).toEqual([{ ubicacionId: idUbicacion(d.ubicacionRecepcion!), ubicacion: d.ubicacionRecepcion, estado: "EN_RECEPCION", cantidad: 25 }]);
    // RF-ENT-011 / RN-INT-004: un movimiento de entrada, y la existencia es la suma de sus asientos.
    const movs = await prisma.movimiento.findMany({ where: { documentoEntradaId: d.id }, include: { asientos: true } });
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ tipo: "ENTRADA", usuarioLogin: "jefe" });
    expect(movs[0]!.asientos.map((a) => Number(a.delta))).toEqual([25]);
    expect(movs[0]!.iniciadoEn.getTime()).toBeLessThanOrEqual(movs[0]!.confirmadoEn.getTime()); // RF-KDX-009
    // HU-LOT-001 criterios 1 y 4: la mercancía queda asociada a un lote, que registra origen y fecha de ingreso.
    const lote = (await pedir(app, coord, "GET", `/api/lotes?skuId=${sku.id}`)).json() as LoteVista[];
    const suyo = lote.find((l) => l.id === d.detalle[0]!.lote!.id)!;
    expect(suyo.origen).toBe(d.origen);
    expect(await prisma.registroBitacora.count({ where: { evento: "entrada_confirmada", entidadId: d.id } })).toBe(1);
  });

  it("HU-LOT-001 criterio 1: se crea el lote o se asocia uno existente del mismo SKU con ese código", async () => {
    const sku = unidades()[5]!;
    const codigo = unico("LOTE").toUpperCase();
    const a = await doc([{ sku, cantidad: 5 }]);
    const ra = (await pieza(a, 0, 5)).json() as DocumentoEntradaVista;
    expect((await confirmar(ra, [{ lineaId: ra.detalle[0]!.id, codigo, origen: "Origen A" }])).statusCode).toBe(200);
    const b = await doc([{ sku, cantidad: 7 }]);
    const rb = (await pieza(b, 0, 7)).json() as DocumentoEntradaVista;
    const cb = (await confirmar(rb, [{ lineaId: rb.detalle[0]!.id, codigo: codigo.toLowerCase(), origen: "Origen B" }])).json() as DocumentoEntradaVista;
    expect(await prisma.lote.count({ where: { skuId: sku.id, codigo } })).toBe(1);
    expect(cb.detalle[0]!.lote!.codigo).toBe(codigo);
    expect((await prisma.lote.findFirstOrThrow({ where: { skuId: sku.id, codigo } })).origen).toBe("Origen A"); // el lote existente conserva su origen
  });

  it("exige elegir el lote de cada línea con mercancía y que sea del mismo SKU", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 4 }]);
    d = (await pieza(d, 0, 4)).json() as DocumentoEntradaVista;
    expect((await confirmar(d, [])).statusCode).toBe(422);
    const ajeno = (await pedir(app, coord, "POST", "/api/lotes", { skuId: unidades()[1]!.id, codigo: unico("AJ"), origen: "Otro SKU" })).json() as LoteVista;
    expect((await confirmar(d, [{ lineaId: d.detalle[0]!.id, loteId: ajeno.id }])).statusCode).toBe(422);
    const propio = (await pedir(app, coord, "POST", "/api/lotes", { skuId: unidades()[0]!.id, codigo: unico("PR"), origen: "Mismo SKU" })).json() as LoteVista;
    expect((await confirmar(d, [{ lineaId: d.detalle[0]!.id, loteId: propio.id }])).statusCode).toBe(200);
  });

  it("criterio 5 (RN-INT-002): una entrada confirmada no se edita, y el kardex es inmutable en la base de datos", async () => {
    const d = await entradaConfirmada(unidades()[0]!, 6);
    expect((await confirmar(d, [])).statusCode).toBe(409);
    expect((await pieza(d, 0, 1)).statusCode).toBe(409);
    expect((await cerrar(d)).statusCode).toBe(409);
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id }, include: { asientos: true } });
    await expect(prisma.movimiento.update({ where: { id: mov.id }, data: { usuarioLogin: "x" } })).rejects.toThrow(/inmutable/i);
    await expect(prisma.movimiento.delete({ where: { id: mov.id } })).rejects.toThrow(/inmutable/i);
    await expect(prisma.asientoKardex.update({ where: { id: mov.asientos[0]!.id }, data: { delta: 99 } })).rejects.toThrow(/inmutable/i);
    await expect(prisma.asientoKardex.delete({ where: { id: mov.asientos[0]!.id } })).rejects.toThrow(/inmutable/i);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AsientoKardex"`)).rejects.toThrow(/inmutable/i);
  });

  it("antes de confirmar hay que cerrar la recepción; el Auxiliar y el Auditor no confirman", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 10 }]);
    d = (await pieza(d, 0, 4)).json() as DocumentoEntradaVista;
    expect((await confirmar(d)).statusCode).toBe(409);
    d = (await cerrar(d)).json() as DocumentoEntradaVista;
    expect((await confirmar(d, null, aux2)).statusCode).toBe(403);
    expect((await confirmar(d, null, auditor)).statusCode).toBe(403);
  });

  it("RN-EXI-001: la base de datos rechaza dejar la existencia por debajo de cero, sin excepción", async () => {
    const d = await entradaConfirmada(unidades()[0]!, 5);
    const p = d.detalle[0]!.piezas[0]!;
    const rec = idUbicacion(d.ubicacionRecepcion!);
    const crear = (delta: number) => prisma.movimiento.create({ data: { tipo: "MOVIMIENTO_INTERNO", usuarioId: "x", usuarioLogin: "x", iniciadoEn: new Date(), asientos: { create: [{ piezaId: p.id, ubicacionId: rec, estado: "EN_RECEPCION", delta }] } } });
    await expect(crear(-5.001)).rejects.toThrow(/por debajo de cero/);
    await expect(crear(-6)).rejects.toThrow(/por debajo de cero/);
    await expect(crear(0)).rejects.toThrow(); // un asiento siempre mueve algo
  });
});

describe("HU-ENT-006 · recibir la ubicación donde dejar la mercancía", () => {
  it("criterio 1 (H-19): propone la zona de su categoría; sin zona de categoría, la recepción", async () => {
    const prenda = (await entradaConfirmada(unidades()[0]!, 4)).detalle[0]!.piezas[0]!;
    const p1 = await propuesta(prenda.id);
    expect(p1).toMatchObject({ criterio: "ZONA_POR_CATEGORIA", ubicacion: { zona: "ALM-A" } });
    const tela = (await entradaConfirmada(skus.find((s) => s.referencia.startsWith("TEL") && s.unidadMedida === "METROS")!, 30.5, "ROLLO")).detalle[0]!.piezas[0]!;
    expect((await propuesta(tela.id)).ubicacion.zona).toBe("ALM-C");
    const insumo = (await entradaConfirmada(skus.find((s) => s.referencia.startsWith("INS"))!, 9)).detalle[0]!.piezas[0]!;
    expect((await propuesta(insumo.id)).ubicacion.zona).toBe("ALM-B");

    const e = await escenario([]); // una categoría cuya zona no tiene ubicaciones
    const sola = (await entradaConfirmada(e.sku, 3)).detalle[0]!.piezas[0]!;
    expect(await propuesta(sola.id)).toMatchObject({ criterio: "RECEPCION", ubicacion: { zona: "REC" } });
  });

  it("criterio 1: entre las ubicaciones de la zona propone la de mayor capacidad libre, y descarta las que no caben", async () => {
    const e = await escenario([100, 500, 250]);
    const p = (await entradaConfirmada(e.sku, 40)).detalle[0]!.piezas[0]!;
    expect((await propuesta(p.id)).ubicacion.codigo).toBe(e.ubicaciones[1]!.codigo); // 500 libres
    const grande = (await entradaConfirmada(e.sku, 300)).detalle[0]!.piezas[0]!;
    expect((await propuesta(grande.id)).ubicacion.codigo).toBe(e.ubicaciones[1]!.codigo); // solo cabe en la de 500
    const demasiado = (await entradaConfirmada(e.sku, 600)).detalle[0]!.piezas[0]!;
    expect((await propuesta(demasiado.id)).criterio).toBe("RECEPCION"); // no cabe en ninguna
  });

  it("criterio 1: antes de la capacidad, agrupa por referencia (ubica junto a lo que ya hay de esa referencia)", async () => {
    const e = await escenario([null, null, null]);
    const primera = (await entradaConfirmada(e.sku, 5)).detalle[0]!.piezas[0]!;
    // Sin nada de la referencia, desempata el código: la primera ubicación.
    expect((await propuesta(primera.id)).ubicacion.codigo).toBe(e.ubicaciones[0]!.codigo);
    const r = await ubicar(primera.id, { destinoId: e.ubicaciones[2]!.id });
    expect(r.statusCode).toBe(201);
    const segunda = (await entradaConfirmada(e.sku, 5)).detalle[0]!.piezas[0]!;
    expect(await propuesta(segunda.id)).toMatchObject({ criterio: "AGRUPACION_POR_REFERENCIA", ubicacion: { codigo: e.ubicaciones[2]!.codigo } });
  });

  it("criterios 2 y 5 (RN-MOV-010): confirma escaneando la mercancía y luego la ubicación; es un movimiento interno y la existencia queda disponible", async () => {
    const e = await escenario([null, null]);
    const d = await entradaConfirmada(e.sku, 12);
    const p = d.detalle[0]!.piezas[0]!;
    const qrLote = ((await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: d.detalle[0]!.lote!.id })).json() as IdentificadorResumen).codigo;
    const qrUbic = ((await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [e.ubicaciones[0]!.id] })).json() as { identificadores: IdentificadorResumen[] }).identificadores[0]!.codigo;

    const r = await ubicar(p.id, { mercanciaCodigo: qrLote.toLowerCase(), destinoCodigo: qrUbic });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ desviacion: false, destino: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE", modo: "ESCANEO" });

    const luego = (await ver(d.id)).detalle[0]!.piezas[0]!;
    expect(luego.ubicaciones).toEqual([{ ubicacionId: e.ubicaciones[0]!.id, ubicacion: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE", cantidad: 12 }]);
    // RN-MOV-004 / RN-MOV-010: el total no cambia; origen -12 y destino +12 en el mismo movimiento.
    const mov = await prisma.movimiento.findFirstOrThrow({ where: { documentoEntradaId: d.id, tipo: "MOVIMIENTO_INTERNO" }, include: { asientos: true } });
    expect(mov.asientos.map((a) => Number(a.delta)).sort((x, y) => x - y)).toEqual([-12, 12]);
    expect(mov).toMatchObject({ modoIdentificacion: "ESCANEO", desviacion: false });
    expect(await prisma.registroBitacora.count({ where: { evento: "pieza_ubicada", entidadId: mov.id } })).toBe(1);
  });

  it("criterio 3 (RN-MOV-003): una ubicación distinta a la propuesta se permite, se registra la desviación y el Coordinador la ve", async () => {
    const e = await escenario([null, null]);
    const p = (await entradaConfirmada(e.sku, 8)).detalle[0]!.piezas[0]!;
    const propuesta0 = await propuesta(p.id);
    expect(propuesta0.ubicacion.codigo).toBe(e.ubicaciones[0]!.codigo);
    const r = await ubicar(p.id, { destinoId: e.ubicaciones[1]!.id }); // otra distinta, elegida a mano
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ desviacion: true, modo: "MANUAL" });
    const mov = await prisma.movimiento.findUniqueOrThrow({ where: { id: r.json().movimientoId } });
    expect(mov).toMatchObject({ desviacion: true, propuestaUbicacionId: e.ubicaciones[0]!.id, modoIdentificacion: "MANUAL" });
    expect(await prisma.registroBitacora.count({ where: { evento: "ubicacion_desviada", entidadId: mov.id } })).toBe(1);
    const lista = (await pedir(app, coord, "GET", "/api/entradas/desviaciones")).json() as DesviacionVista[];
    expect(lista.find((x) => x.movimientoId === mov.id)).toMatchObject({ propuesta: e.ubicaciones[0]!.codigo, elegida: e.ubicaciones[1]!.codigo, usuario: "auxiliar1", pieza: p.numero });
    expect((await pedir(app, aux1, "GET", "/api/entradas/desviaciones")).statusCode).toBe(403);
  });

  it("criterio 4 (RN-MOV-002): el destino debe estar activo y tener capacidad", async () => {
    const e = await escenario([10, 100]);
    const p = (await entradaConfirmada(e.sku, 30)).detalle[0]!.piezas[0]!;
    const sinCupo = await ubicar(p.id, { destinoId: e.ubicaciones[0]!.id });
    expect(sinCupo.statusCode).toBe(409);
    expect(sinCupo.json().error).toContain("capacidad");
    await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${e.ubicaciones[1]!.id}/desactivar`);
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[1]!.id })).json().error).toContain("desactivada");
    await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${e.ubicaciones[1]!.id}/reactivar`);
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[1]!.id })).statusCode).toBe(201);
    // Lo que ya está ocupa: otra pieza de 80 ya no cabe (30 + 80 > 100).
    const q = (await entradaConfirmada(e.sku, 80)).detalle[0]!.piezas[0]!;
    expect((await ubicar(q.id, { destinoId: e.ubicaciones[1]!.id })).statusCode).toBe(409);
  });

  it("rechaza destinos que no corresponden: cuarentena, otra mercancía, un código que no es de ubicación, la misma ubicación", async () => {
    const e = await escenario([null]);
    const d = await entradaConfirmada(e.sku, 5);
    const p = d.detalle[0]!.piezas[0]!;
    expect((await ubicar(p.id, { destinoId: idUbicacion("CUA-01") })).json().error).toContain("cuarentena");
    expect((await ubicar(p.id, { destinoId: d.ubicacionRecepcion ? idUbicacion(d.ubicacionRecepcion) : "" })).statusCode).toBe(422); // la misma de recepción
    expect((await ubicar(p.id, {})).statusCode).toBe(422);
    expect((await ubicar(p.id, { destinoId: "no-existe" })).statusCode).toBe(404);

    const otraMercancia = ((await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: ((await pedir(app, coord, "POST", "/api/lotes", { skuId: e.sku.id, codigo: unico("OTRO"), origen: "Otro lote" })).json() as LoteVista).id })).json() as IdentificadorResumen).codigo;
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[0]!.id, mercanciaCodigo: otraMercancia })).json().error).toContain("no corresponde");
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[0]!.id, mercanciaCodigo: "COL-M-AAAAA-AAAAA" })).statusCode).toBe(409);
    expect((await ubicar(p.id, { destinoCodigo: otraMercancia })).json().error).toContain("no es el de una ubicación");
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[0]!.id }, auditor)).statusCode).toBe(403);
  });

  it("RN-MOV-010: ubicar en otra ubicación de recepción la deja EN RECEPCION, y una pieza ya ubicada no se ubica de nuevo", async () => {
    const d = await entradaConfirmada(unidades()[0]!, 3);
    const p = d.detalle[0]!.piezas[0]!;
    const otraRec = zonaDe("REC").ubicaciones.find((u) => u.codigo !== d.ubicacionRecepcion)!;
    const r = await ubicar(p.id, { destinoId: otraRec.id });
    expect(r.json()).toMatchObject({ estado: "EN_RECEPCION" });
    const donde = (await ver(d.id)).detalle[0]!.piezas[0]!.ubicaciones;
    expect(donde).toEqual([{ ubicacionId: otraRec.id, ubicacion: otraRec.codigo, estado: "EN_RECEPCION", cantidad: 3 }]);

    const e = await escenario([null]);
    const q = (await entradaConfirmada(e.sku, 3)).detalle[0]!.piezas[0]!;
    expect((await ubicar(q.id, { destinoId: e.ubicaciones[0]!.id })).statusCode).toBe(201);
    expect((await ubicar(q.id, { destinoId: otraRec.id })).statusCode).toBe(409);
  });

  it("la pieza solo se ubica con la entrada confirmada", async () => {
    let d = await doc([{ sku: unidades()[0]!, cantidad: 4 }]);
    d = (await pieza(d, 0, 4)).json() as DocumentoEntradaVista;
    const r = await ubicar(d.detalle[0]!.piezas[0]!.id, { destinoId: idUbicacion("ALM-A-01") });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("confirmada");
  });

  it("RN-EXI-001: dos ubicaciones simultáneas de la misma pieza no la duplican; una gana y la otra se rechaza", async () => {
    const e = await escenario([null, null]);
    const p = (await entradaConfirmada(e.sku, 20)).detalle[0]!.piezas[0]!;
    const [a, b] = await Promise.all([ubicar(p.id, { destinoId: e.ubicaciones[0]!.id }), ubicar(p.id, { destinoId: e.ubicaciones[1]!.id }, aux2)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const total = await prisma.asientoKardex.aggregate({ where: { piezaId: p.id }, _sum: { delta: true } });
    expect(Number(total._sum.delta)).toBe(20); // el total nunca cambia (RN-MOV-004)
  });

  it("la zona de una categoría la configura el Administrador y queda en la bitácora", async () => {
    const e = await escenario([null]);
    expect((await pedir(app, jefe, "PATCH", `/api/bodega/zonas/${e.zonaId}/categoria`, { categoriaId: null })).statusCode).toBe(403);
    expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${e.zonaId}/categoria`, { categoriaId: "no-existe" })).statusCode).toBe(422);
    expect((await pedir(app, admin, "PATCH", `/api/bodega/zonas/${e.zonaId}/categoria`, { categoriaId: null })).statusCode).toBe(200);
    expect((await pedir(app, admin, "PATCH", "/api/bodega/zonas/no-existe/categoria", { categoriaId: null })).statusCode).toBe(404);
    const zona = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[])[0]!.zonas.find((z) => z.id === e.zonaId)!;
    expect(zona.categoriaId).toBeNull();
    expect(await prisma.registroBitacora.count({ where: { evento: "zona_categoria_modificada", entidadId: e.zonaId } })).toBe(2);
  });
});

describe("existencia derivada del kardex (RN-INT-004) activa las reglas que esperaban el bloque", () => {
  it("RN-004: la unidad de una referencia con movimientos no cambia", async () => {
    const e = await escenario([null]);
    const ref = await prisma.referencia.findFirstOrThrow({ where: { skus: { some: { id: e.sku.id } } } });
    expect((await pedir(app, jefe, "PATCH", `/api/catalogo/referencias/${ref.id}`, { unidadMedida: "KILOGRAMOS" })).statusCode).toBe(200); // sin movimientos todavía
    await pedir(app, jefe, "PATCH", `/api/catalogo/referencias/${ref.id}`, { unidadMedida: "UNIDADES" });
    await entradaConfirmada(e.sku, 5);
    const r = await pedir(app, jefe, "PATCH", `/api/catalogo/referencias/${ref.id}`, { unidadMedida: "KILOGRAMOS" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("movimientos");
  });

  it("RN-MAE-003: una referencia con existencia no se desactiva", async () => {
    const e = await escenario([null]);
    const ref = await prisma.referencia.findFirstOrThrow({ where: { skus: { some: { id: e.sku.id } } } });
    await entradaConfirmada(e.sku, 5);
    const r = await pedir(app, jefe, "POST", `/api/catalogo/referencias/${ref.id}/desactivar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("existencia");
  });

  it("RN-013: una ubicación con existencia no se desactiva", async () => {
    const e = await escenario([null]);
    const p = (await entradaConfirmada(e.sku, 5)).detalle[0]!.piezas[0]!;
    expect((await ubicar(p.id, { destinoId: e.ubicaciones[0]!.id })).statusCode).toBe(201);
    const r = await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${e.ubicaciones[0]!.id}/desactivar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("existencia");
    // Y la de la recepción, mientras guarde la entrada, tampoco.
    const rec = (await ver((await entradaConfirmada(e.sku, 2)).id)).ubicacionRecepcion!;
    expect((await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${idUbicacion(rec)}/desactivar`)).statusCode).toBe(409);
  });

  it("HU-QRC-002 criterio 2: el escaneo muestra las ubicaciones donde el SKU + Lote tiene existencia", async () => {
    const e = await escenario([null]);
    const d = await entradaConfirmada(e.sku, 14);
    const qr = ((await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: d.detalle[0]!.lote!.id })).json() as IdentificadorResumen).codigo;
    const antes = (await pedir(app, aux1, "POST", "/api/identificadores/resolver", { codigo: qr })).json();
    expect(antes.ubicaciones).toEqual([{ ubicacionId: idUbicacion(d.ubicacionRecepcion!), ubicacion: d.ubicacionRecepcion, estado: "EN_RECEPCION", cantidad: 14 }]);
    await ubicar(d.detalle[0]!.piezas[0]!.id, { destinoId: e.ubicaciones[0]!.id });
    const despues = (await pedir(app, aux1, "POST", "/api/identificadores/resolver", { codigo: qr })).json();
    expect(despues.ubicaciones).toEqual([{ ubicacionId: e.ubicaciones[0]!.id, ubicacion: e.ubicaciones[0]!.codigo, estado: "DISPONIBLE", cantidad: 14 }]);
  });
});
