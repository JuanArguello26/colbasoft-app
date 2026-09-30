import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ReferenciaDetalle, ReferenciaResumen } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let jefe: string;
let aux: string;
let categoriaId: string;
let tallaIds: string[];
let colorIds: string[];

beforeAll(async () => {
  app = await iniciarApp();
  jefe = await entrar(app, "jefe");
  aux = await entrar(app, "auxiliar1");
  categoriaId = ((await pedir(app, jefe, "GET", "/api/catalogo/categorias")).json() as Array<{ id: string }>)[0]!.id;
  tallaIds = ((await pedir(app, jefe, "GET", "/api/catalogo/tallas")).json() as Array<{ id: string }>).slice(0, 3).map((t) => t.id);
  colorIds = ((await pedir(app, jefe, "GET", "/api/catalogo/colores")).json() as Array<{ id: string }>).slice(0, 2).map((t) => t.id);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const nueva = (codigo: string, extra: object = {}) => ({ codigo, descripcion: "Camiseta de prueba", categoriaId, unidadMedida: "UNIDADES", tallaIds, colorIds, ...extra });

describe("HU-CAT-001 · crear una referencia con sus tallas y colores", () => {
  it("criterios 2 a 4: genera los SKU de la combinación y queda activa", async () => {
    const codigo = unico("R");
    const r = await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(codigo));
    expect(r.statusCode).toBe(201);
    const ref = r.json() as ReferenciaResumen;
    expect(ref.activa).toBe(true);
    expect(ref.skus).toBe(tallaIds.length * colorIds.length); // 3 tallas x 2 colores
    const det = (await pedir(app, jefe, "GET", `/api/catalogo/referencias/${ref.id}`)).json() as ReferenciaDetalle;
    expect(det.tallas).toHaveLength(3);
    expect(det.colores).toHaveLength(2);
    expect(await prisma.registroBitacora.count({ where: { evento: "referencia_creada", entidadId: ref.id } })).toBe(1);
  });

  it("criterio 1 y 5 (RN-002): el código es único, sin distinguir mayúsculas, y se rechaza con explicación", async () => {
    const codigo = unico("r");
    expect((await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(codigo))).statusCode).toBe(201);
    const dup = await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(codigo.toUpperCase()));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain("Ya existe");
  });

  it("exige al menos una talla y un color, y que existan en los conjuntos de la empresa", async () => {
    expect((await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R"), { tallaIds: [] }))).statusCode).toBe(422);
    expect((await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R"), { colorIds: [] }))).statusCode).toBe(422);
    expect((await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R"), { tallaIds: ["no-existe"] }))).statusCode).toBe(422);
  });

  it("solo Administrador y Jefe crean referencias; los demás roles solo consultan", async () => {
    expect((await pedir(app, aux, "POST", "/api/catalogo/referencias", nueva(unico("R")))).statusCode).toBe(403);
    expect((await pedir(app, aux, "GET", "/api/catalogo/referencias")).statusCode).toBe(200);
    expect((await pedir(app, await entrar(app, "auditor"), "POST", "/api/catalogo/tallas", { nombre: "XXL" })).statusCode).toBe(403);
  });

  it("puede crear valores nuevos de talla, color y categoría, sin duplicar", async () => {
    const n = unico("Talla");
    expect((await pedir(app, jefe, "POST", "/api/catalogo/tallas", { nombre: n })).statusCode).toBe(201);
    expect((await pedir(app, jefe, "POST", "/api/catalogo/tallas", { nombre: n })).statusCode).toBe(409);
    expect((await pedir(app, jefe, "POST", "/api/catalogo/colores", { nombre: unico("Color") })).statusCode).toBe(201);
    expect((await pedir(app, jefe, "POST", "/api/catalogo/categorias", { nombre: unico("Categoría") })).statusCode).toBe(201);
  });
});

describe("HU-CAT-002 · unidad de medida", () => {
  it("se puede cambiar mientras no haya movimientos y el cambio queda en la bitácora", async () => {
    const ref = (await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R")))).json() as ReferenciaResumen;
    const r = await pedir(app, jefe, "PATCH", `/api/catalogo/referencias/${ref.id}`, { unidadMedida: "METROS" });
    expect(r.statusCode).toBe(200);
    expect((r.json() as ReferenciaResumen).unidadMedida).toBe("METROS");
    expect(await prisma.registroBitacora.count({ where: { evento: "referencia_modificada", entidadId: ref.id } })).toBe(1);
  });

  it("rechaza una unidad fuera de la lista", async () => {
    const ref = (await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R")))).json() as ReferenciaResumen;
    expect((await pedir(app, jefe, "PATCH", `/api/catalogo/referencias/${ref.id}`, { unidadMedida: "LITROS" })).statusCode).toBe(422);
  });

  // RN-004 (criterios 2 y 4): hoy no existen movimientos. Se activa cuando exista el kardex (bloque C1-3).
  it.todo("rechaza el cambio de unidad si la referencia ya tiene movimientos (RN-004)");
  it.todo("no permite desactivar una referencia con existencia (RN-MAE-003)");
});

describe("RN-063 · nada se elimina", () => {
  it("una referencia se desactiva y reactiva; no existe la eliminación", async () => {
    const ref = (await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(unico("R")))).json() as ReferenciaResumen;
    expect((await pedir(app, jefe, "POST", `/api/catalogo/referencias/${ref.id}/desactivar`)).statusCode).toBe(200);
    expect((await pedir(app, jefe, "POST", `/api/catalogo/referencias/${ref.id}/desactivar`)).statusCode).toBe(409);
    // sigue ocupando su código (RN-002: activa o inactiva)
    expect((await pedir(app, jefe, "POST", "/api/catalogo/referencias", nueva(ref.codigo))).statusCode).toBe(409);
    expect((await pedir(app, jefe, "POST", `/api/catalogo/referencias/${ref.id}/reactivar`)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/catalogo/referencias/${ref.id}`, cookies: { token: jefe } })).statusCode).toBe(404);
  });
});
