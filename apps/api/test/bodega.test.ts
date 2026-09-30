import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BodegaVista } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await iniciarApp();
  admin = await entrar(app, "admin");
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const crearBodega = async () => {
  const cod = unico("B").toUpperCase();
  const r = await pedir(app, admin, "POST", "/api/bodega/bodegas", { codigo: cod, nombre: "Bodega de prueba", zonaRecepcion: { codigo: "REC", nombre: "Recepción", ubicacionCodigo: "REC-01" } });
  expect(r.statusCode).toBe(201);
  const b = ((await pedir(app, admin, "GET", "/api/bodega")).json() as BodegaVista[]).find((x) => x.codigo === cod)!;
  return b;
};

describe("HU-BOD-001 · zonas y ubicaciones", () => {
  it("criterio 4 (RN-019, RN-EXI-007): toda bodega nace con una zona de recepción que tiene al menos una ubicación", async () => {
    const b = await crearBodega();
    const rec = b.zonas.find((z) => z.tipo === "RECEPCION");
    expect(rec).toBeDefined();
    expect(rec!.ubicaciones.length).toBeGreaterThanOrEqual(1);
    expect((await pedir(app, admin, "POST", "/api/bodega/bodegas", { codigo: unico("B"), nombre: "Sin recepción" })).statusCode).toBe(422);
  });

  it("criterio 1: crea zonas con tipo asignado; una zona de recepción extra no se admite sin ubicación", async () => {
    const b = await crearBodega();
    const z = await pedir(app, admin, "POST", `/api/bodega/bodegas/${b.id}/zonas`, { codigo: "ALM", nombre: "Almacenamiento", tipo: "ALMACENAMIENTO" });
    expect(z.statusCode).toBe(201);
    expect((await pedir(app, admin, "POST", `/api/bodega/bodegas/${b.id}/zonas`, { codigo: "ALM", nombre: "Otra", tipo: "ALMACENAMIENTO" })).statusCode).toBe(409);
    expect((await pedir(app, admin, "POST", `/api/bodega/bodegas/${b.id}/zonas`, { codigo: "R2", nombre: "Recepción 2", tipo: "RECEPCION" })).statusCode).toBe(422);
    expect((await pedir(app, admin, "POST", `/api/bodega/bodegas/${b.id}/zonas`, { codigo: "X", nombre: "Zona rara", tipo: "OTRA" })).statusCode).toBe(422);
  });

  it("criterios 2 y 3 (RN-014): el código de ubicación es único dentro de la bodega, pero puede repetirse en otra", async () => {
    const b1 = await crearBodega();
    const b2 = await crearBodega();
    const zona1 = (await pedir(app, admin, "POST", `/api/bodega/bodegas/${b1.id}/zonas`, { codigo: "ALM", nombre: "Almacenamiento", tipo: "ALMACENAMIENTO" })).json() as { id: string };
    const zona2 = (await pedir(app, admin, "POST", `/api/bodega/bodegas/${b2.id}/zonas`, { codigo: "ALM", nombre: "Almacenamiento", tipo: "ALMACENAMIENTO" })).json() as { id: string };
    expect((await pedir(app, admin, "POST", `/api/bodega/zonas/${zona1.id}/ubicaciones`, { codigo: "A-01" })).statusCode).toBe(201);
    expect((await pedir(app, admin, "POST", `/api/bodega/zonas/${zona1.id}/ubicaciones`, { codigo: "a-01" })).statusCode).toBe(409); // mismo código en la misma bodega
    expect((await pedir(app, admin, "POST", `/api/bodega/zonas/${zona2.id}/ubicaciones`, { codigo: "A-01" })).statusCode).toBe(201); // otra bodega: permitido
  });

  it("solo el Administrador define la estructura; todos los roles la consultan", async () => {
    const jefe = await entrar(app, "jefe");
    expect((await pedir(app, jefe, "POST", "/api/bodega/bodegas", { codigo: unico("B"), nombre: "No", zonaRecepcion: { codigo: "R", nombre: "R", ubicacionCodigo: "R1" } })).statusCode).toBe(403);
    expect((await pedir(app, await entrar(app, "auxiliar1"), "GET", "/api/bodega")).statusCode).toBe(200);
  });
});

describe("HU-BOD-002 · capacidad de las ubicaciones", () => {
  it("criterio 4: una ubicación sin capacidad se lista como pendiente de configurar", async () => {
    const b = await crearBodega();
    const u = b.zonas[0]!.ubicaciones[0]!;
    let pendientes = (await pedir(app, admin, "GET", "/api/bodega/ubicaciones/pendientes-capacidad")).json() as Array<{ id: string }>;
    expect(pendientes.some((p) => p.id === u.id)).toBe(true);

    expect((await pedir(app, admin, "PATCH", `/api/bodega/ubicaciones/${u.id}/capacidad`, { capacidad: 40, unidadCapacidad: "ROLLOS" })).statusCode).toBe(200);
    pendientes = (await pedir(app, admin, "GET", "/api/bodega/ubicaciones/pendientes-capacidad")).json() as Array<{ id: string }>;
    expect(pendientes.some((p) => p.id === u.id)).toBe(false);
    expect(await prisma.registroBitacora.count({ where: { evento: "capacidad_modificada", entidadId: u.id } })).toBe(1);
  });

  it("la capacidad es positiva y va con su unidad", async () => {
    const b = await crearBodega();
    const u = b.zonas[0]!.ubicaciones[0]!;
    expect((await pedir(app, admin, "PATCH", `/api/bodega/ubicaciones/${u.id}/capacidad`, { capacidad: -5, unidadCapacidad: "UNIDADES" })).statusCode).toBe(422);
    expect((await pedir(app, admin, "PATCH", `/api/bodega/ubicaciones/${u.id}/capacidad`, { capacidad: 10, unidadCapacidad: null })).statusCode).toBe(422);
  });
});

describe("RN-063, RN-013 y RN-EXI-007 · desactivar ubicaciones", () => {
  it("una ubicación se desactiva y se reactiva; nunca se elimina", async () => {
    const b = await crearBodega();
    const z = (await pedir(app, admin, "POST", `/api/bodega/bodegas/${b.id}/zonas`, { codigo: "ALM", nombre: "Almacenamiento", tipo: "ALMACENAMIENTO" })).json() as { id: string };
    const u = (await pedir(app, admin, "POST", `/api/bodega/zonas/${z.id}/ubicaciones`, { codigo: "A-01" })).json() as { id: string };
    expect((await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${u.id}/desactivar`)).statusCode).toBe(200);
    expect((await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${u.id}/reactivar`)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/bodega/ubicaciones/${u.id}`, cookies: { token: admin } })).statusCode).toBe(404);
  });

  it("la zona de recepción conserva al menos una ubicación activa", async () => {
    const b = await crearBodega();
    const unica = b.zonas.find((z) => z.tipo === "RECEPCION")!.ubicaciones[0]!;
    const r = await pedir(app, admin, "POST", `/api/bodega/ubicaciones/${unica.id}/desactivar`);
    expect(r.statusCode).toBe(409);
  });

  it.todo("una ubicación con existencia no puede desactivarse (RN-013): se activa con el bloque C1-3");
});
