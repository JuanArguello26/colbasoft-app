import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista, EtiquetaVista, IdentificadorResumen, LoteVista, ResolucionVista, SkuVista } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string;
let jefe: string;
let coord: string;
let aux: string;
let auditor: string;
let skus: SkuVista[];
let bodegas: BodegaVista[];

beforeAll(async () => {
  app = await iniciarApp();
  [admin, jefe, coord, aux, auditor] = await Promise.all(["admin", "jefe", "coordinador", "auxiliar1", "auditor"].map((l) => entrar(app, l)));
  skus = (await pedir(app, coord, "GET", "/api/lotes/skus")).json() as SkuVista[];
  bodegas = (await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[];
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const crearLote = (token: string, extra: object = {}, sku = skus[0]!) =>
  pedir(app, token, "POST", "/api/lotes", { skuId: sku.id, codigo: unico("L"), origen: "Proveedor de prueba", ...extra });
const lote = async (sku = skus[0]!) => (await crearLote(coord, {}, sku)).json() as LoteVista;
const generar = async (loteId: string) => (await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId })).json() as IdentificadorResumen;
const escanear = (token: string, codigo: string, modo = "ESCANEO") => pedir(app, token, "POST", "/api/identificadores/resolver", { codigo, modo });

describe("HU-LOT-001 · asociar la mercancía a un lote", () => {
  it("criterio 2: el lote registra origen y fecha de ingreso, y se consulta con su SKU", async () => {
    const antes = Date.now();
    const r = await crearLote(coord, { codigo: "lote-uno-" + unico("") });
    expect(r.statusCode).toBe(201);
    const l = r.json() as LoteVista;
    expect(l.origen).toBe("Proveedor de prueba");
    expect(Math.abs(new Date(l.fechaIngreso).getTime() - antes)).toBeLessThan(10_000);
    expect(l.codigo).toBe(l.codigo.toUpperCase());
    const c = (await pedir(app, aux, "GET", `/api/lotes/${l.id}`)).json() as LoteVista;
    expect(c.sku.referencia).toBe(skus[0]!.referencia);
    expect(c.identificador).toBeNull();
    expect(await prisma.registroBitacora.count({ where: { evento: "lote_creado", entidadId: l.id } })).toBe(1);
  });

  it("criterio 3 (RN-MAE-006): el código es único dentro de su SKU, pero puede repetirse en otro SKU", async () => {
    const codigo = unico("U");
    expect((await crearLote(coord, { codigo })).statusCode).toBe(201);
    const dup = await crearLote(jefe, { codigo: codigo.toLowerCase() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain("Ya existe");
    expect((await crearLote(coord, { codigo }, skus[1]!)).statusCode).toBe(201);
  });

  it("criterio 3: dos peticiones simultáneas con el mismo código no crean dos lotes", async () => {
    const codigo = unico("C");
    const respuestas = await Promise.all([crearLote(coord, { codigo }), crearLote(jefe, { codigo }), crearLote(admin, { codigo })]);
    expect(respuestas.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
  });

  it("criterio 5: el lote aparece en las consultas, filtradas por SKU o por texto", async () => {
    const l = await lote(skus[2]!);
    const porSku = (await pedir(app, aux, "GET", `/api/lotes?skuId=${skus[2]!.id}`)).json() as LoteVista[];
    expect(porSku.some((x) => x.id === l.id)).toBe(true);
    expect(porSku.every((x) => x.sku.id === skus[2]!.id)).toBe(true);
    const porTexto = (await pedir(app, aux, "GET", `/api/lotes?q=${l.codigo.toLowerCase()}`)).json() as LoteVista[];
    expect(porTexto.map((x) => x.id)).toEqual([l.id]);
  });

  it("solo Administrador, Jefe y Coordinador crean lotes; el Auxiliar y el Auditor no", async () => {
    expect((await crearLote(aux)).statusCode).toBe(403);
    expect((await crearLote(auditor)).statusCode).toBe(403);
    expect((await crearLote(admin)).statusCode).toBe(201);
  });

  it("valida los datos: origen obligatorio, SKU existente y referencia activa", async () => {
    expect((await crearLote(coord, { origen: " " })).statusCode).toBe(422);
    expect((await crearLote(coord, { codigo: "" })).statusCode).toBe(422);
    expect((await crearLote(coord, { skuId: "no-existe" })).statusCode).toBe(404);
    const sku = await prisma.sku.findUniqueOrThrow({ where: { id: skus[3]!.id } });
    await prisma.referencia.update({ where: { id: sku.referenciaId }, data: { activa: false } });
    try {
      expect((await crearLote(coord, {}, skus[3]!)).statusCode).toBe(422);
    } finally {
      await prisma.referencia.update({ where: { id: sku.referenciaId }, data: { activa: true } });
    }
  });

  // Criterios 1 y 4 (al confirmar una entrada se crea o asocia el lote; ninguna existencia sin lote): entradas.test.ts.
});

describe("HU-QRC-001 · generar e imprimir códigos QR de la mercancía", () => {
  it("criterios 1 y 4: un identificador único por SKU + Lote, activo, que no depende de la ubicación", async () => {
    const l = await lote();
    const r = await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: l.id });
    expect(r.statusCode).toBe(201);
    const id = r.json() as IdentificadorResumen;
    expect(id.estado).toBe("ACTIVO");
    expect(id.tipo).toBe("MERCANCIA");
    expect(id.codigo).toMatch(/^COL-M-[ACDEFGHJKMNPQRTUVWXY34679]{5}-[ACDEFGHJKMNPQRTUVWXY34679]{5}$/);
    expect(id.ubicacionId).toBeNull();
    expect(id.loteId).toBe(l.id);
    expect((await pedir(app, coord, "GET", `/api/lotes/${l.id}`)).json<LoteVista>().identificador?.codigo).toBe(id.codigo);
    expect(await prisma.registroBitacora.count({ where: { evento: "identificador_generado", entidadId: id.id } })).toBe(1);
  });

  it("un lote no recibe un segundo identificador; un lote inexistente se rechaza", async () => {
    const l = await lote();
    await generar(l.id);
    const otra = await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: l.id });
    expect(otra.statusCode).toBe(409);
    expect((await pedir(app, coord, "POST", "/api/identificadores/mercancia", { loteId: "no-existe" })).statusCode).toBe(404);
  });

  it("criterio 5 (RN-IDE-002): ningún identificador se repite; la base impide borrarlos, cambiarlos o reactivarlos", async () => {
    const lotes = await Promise.all(Array.from({ length: 12 }, () => lote()));
    const ids = await Promise.all(lotes.map((l) => generar(l.id)));
    expect(new Set(ids.map((i) => i.codigo)).size).toBe(ids.length);

    const i = ids[0]!;
    await expect(prisma.identificador.delete({ where: { id: i.id } })).rejects.toThrow(/no se elimina/i);
    await expect(prisma.identificador.update({ where: { id: i.id }, data: { codigo: "COL-M-AAAAA-BBBBB" } })).rejects.toThrow(/no cambia/i);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "Identificador" CASCADE`)).rejects.toThrow(/no se elimina/i);
    // Anular sí se puede, y desde ahí no hay vuelta atrás.
    await prisma.identificador.update({ where: { id: i.id }, data: { estado: "ANULADO" } });
    await expect(prisma.identificador.update({ where: { id: i.id }, data: { estado: "ACTIVO" } })).rejects.toThrow(/no se reactiva/i);
    // El valor anulado sigue ocupado: nadie puede emitirlo de nuevo.
    await expect(prisma.identificador.create({ data: { codigo: i.codigo, tipo: "UBICACION", ubicacionId: bodegas[0]!.zonas[0]!.ubicaciones[0]!.id } })).rejects.toThrow();
  });

  it("DF5-01: un identificador es de mercancía o de ubicación, nunca de ambas ni de ninguna", async () => {
    const l = await lote();
    const u = bodegas[0]!.zonas[0]!.ubicaciones[0]!.id;
    await expect(prisma.identificador.create({ data: { codigo: unico("COL-M-X"), tipo: "MERCANCIA", loteId: l.id, ubicacionId: u } })).rejects.toThrow();
    await expect(prisma.identificador.create({ data: { codigo: unico("COL-M-Y"), tipo: "MERCANCIA" } })).rejects.toThrow();
  });

  it("criterios 2 y 3: imprime una etiqueta o varias, con referencia, talla, color y lote legibles", async () => {
    const [a, b] = [await lote(skus[0]!), await lote(skus[1]!)];
    const [ia, ib] = [await generar(a.id), await generar(b.id)];

    const una = (await pedir(app, coord, "GET", `/api/identificadores/etiquetas?ids=${ia.id}`)).json() as EtiquetaVista[];
    expect(una).toHaveLength(1);
    expect(una[0]!.mercancia).toEqual({ referencia: skus[0]!.referencia, descripcion: skus[0]!.descripcion, talla: skus[0]!.talla, color: skus[0]!.color, lote: a.codigo });
    expect(una[0]!.svg).toMatch(/^<svg/);
    expect(una[0]!.codigo).toBe(ia.codigo);

    const varias = (await pedir(app, jefe, "GET", `/api/identificadores/etiquetas?ids=${ib.id},${ia.id}`)).json() as EtiquetaVista[];
    expect(varias.map((e) => e.id)).toEqual([ib.id, ia.id]);
  });

  it("las etiquetas exigen rol y ids válidos", async () => {
    const i = await generar((await lote()).id);
    expect((await pedir(app, aux, "GET", `/api/identificadores/etiquetas?ids=${i.id}`)).statusCode).toBe(403);
    expect((await pedir(app, auditor, "POST", "/api/identificadores/mercancia", { loteId: "x" })).statusCode).toBe(403);
    expect((await pedir(app, coord, "GET", "/api/identificadores/etiquetas")).statusCode).toBe(422);
    expect((await pedir(app, coord, "GET", `/api/identificadores/etiquetas?ids=${i.id},no-existe`)).statusCode).toBe(404);
  });
});

describe("HU-QRC-003 · códigos QR de las ubicaciones", () => {
  const zona = () => bodegas[0]!.zonas.find((z) => z.ubicaciones.filter((u) => u.activa).length > 0)!;

  it("criterio 1: cada ubicación tiene su propio identificador, y pedirlo otra vez no crea otro", async () => {
    const u = zona().ubicaciones[0]!;
    const r1 = (await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id] })).json() as { identificadores: IdentificadorResumen[]; nuevos: number };
    const r2 = (await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id] })).json() as { identificadores: IdentificadorResumen[]; nuevos: number };
    expect(r2.nuevos).toBe(0);
    expect(r2.identificadores[0]!.codigo).toBe(r1.identificadores[0]!.codigo);
    expect(r1.identificadores[0]).toMatchObject({ tipo: "UBICACION", estado: "ACTIVO", ubicacionId: u.id, loteId: null });
  });

  it("criterio 2: se generan e imprimen todas las ubicaciones activas de una zona", async () => {
    const z = zona();
    const r = await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { zonaId: z.id });
    expect(r.statusCode).toBe(201);
    const { identificadores } = r.json() as { identificadores: IdentificadorResumen[] };
    expect(identificadores).toHaveLength(z.ubicaciones.filter((u) => u.activa).length);
    const e = (await pedir(app, admin, "GET", `/api/identificadores/etiquetas?ids=${identificadores.map((i) => i.id).join(",")}`)).json() as EtiquetaVista[];
    expect(e.every((x) => x.ubicacion && x.svg.startsWith("<svg"))).toBe(true);
    expect(e[0]!.ubicacion).toMatchObject({ bodega: bodegas[0]!.codigo, zona: z.codigo });
  });

  it("criterio 4: el identificador de ubicación se distingue del de mercancía", async () => {
    const u = zona().ubicaciones[0]!;
    const ub = ((await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id] })).json() as { identificadores: IdentificadorResumen[] }).identificadores[0]!;
    const me = await generar((await lote()).id);
    expect(ub.codigo.startsWith("COL-U-")).toBe(true);
    expect(me.codigo.startsWith("COL-M-")).toBe(true);
    expect((await escanear(aux, ub.codigo)).json<ResolucionVista>().tipo).toBe("UBICACION");
    expect((await escanear(aux, me.codigo)).json<ResolucionVista>().tipo).toBe("MERCANCIA");
  });

  it("solo el Administrador genera e imprime identificadores de ubicación", async () => {
    const u = zona().ubicaciones[0]!;
    expect((await pedir(app, coord, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id] })).statusCode).toBe(403);
    const ub = ((await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id] })).json() as { identificadores: IdentificadorResumen[] }).identificadores[0]!;
    expect((await pedir(app, coord, "GET", `/api/identificadores/etiquetas?ids=${ub.id}`)).statusCode).toBe(403);
    expect((await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: [u.id], zonaId: zona().id })).statusCode).toBe(422);
    expect((await pedir(app, admin, "POST", "/api/identificadores/ubicaciones", { ubicacionIds: ["no-existe"] })).statusCode).toBe(404);
  });
});

describe("HU-QRC-002 · escanear el QR en lugar de escribir códigos", () => {
  it("criterio 2: resuelve el identificador al SKU + Lote y a las ubicaciones con existencia", async () => {
    const l = await lote(skus[1]!);
    const i = await generar(l.id);
    const r = await escanear(aux, i.codigo);
    expect(r.statusCode).toBe(200);
    const v = r.json() as Extract<ResolucionVista, { tipo: "MERCANCIA" }>;
    expect(v.sku).toMatchObject({ referencia: skus[1]!.referencia, talla: skus[1]!.talla, color: skus[1]!.color });
    expect(v.lote).toMatchObject({ id: l.id, codigo: l.codigo, origen: l.origen });
    expect(v.ubicaciones).toEqual([]); // sin movimientos (C1-3) no hay existencia
  });

  it("acepta el código digitado con espacios o en minúsculas", async () => {
    const i = await generar((await lote()).id);
    expect((await escanear(aux, `  ${i.codigo.toLowerCase()} `, "MANUAL")).statusCode).toBe(200);
  });

  it("criterio 3: un código desconocido se informa, ofrece reportar novedad y queda en la bitácora", async () => {
    const codigo = "COL-M-AAAAA-AAAAA"; // nunca emitido
    const r = await escanear(aux, codigo);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ reconocido: false, ofrecerNovedad: true });
    expect(await prisma.registroBitacora.count({ where: { evento: "identificador_no_reconocido" } })).toBeGreaterThan(0);
  });

  it("criterio 4: un identificador anulado se informa y se rechaza la operación", async () => {
    const i = await generar((await lote()).id);
    await prisma.identificador.update({ where: { id: i.id }, data: { estado: "ANULADO" } });
    const r = await escanear(aux, i.codigo);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ estado: "ANULADO" });
    expect(await prisma.registroBitacora.count({ where: { evento: "identificador_anulado_rechazado", entidadId: i.id } })).toBe(1);
  });

  it("criterio 5 (RNF-REN-002): la resolución se completa en menos de 2 segundos", async () => {
    const i = await generar((await lote()).id);
    const t0 = performance.now();
    const r = await escanear(aux, i.codigo);
    expect(r.statusCode).toBe(200);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("exige sesión y un código", async () => {
    expect((await app.inject({ method: "POST", url: "/api/identificadores/resolver", payload: { codigo: "COL-M-AAAAA-BBBBB" } })).statusCode).toBe(401);
    expect((await escanear(aux, "   ")).statusCode).toBe(422);
  });
});
