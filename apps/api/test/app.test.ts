import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { construirApp } from "../src/app.js";
import { cargarExcel } from "../src/datos/cargar-excel.js";
import { prisma } from "../src/db.js";

let app: FastifyInstance;

beforeAll(async () => {
  await cargarExcel(resolve(process.cwd(), "../../data/datos_ficticios.xlsx"));
  app = await construirApp({ jwtSecret: "secreto-de-prueba" });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("salud", () => {
  it("responde y ve la base de datos", async () => {
    const r = await app.inject({ method: "GET", url: "/api/salud" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ estado: "ok", baseDeDatos: "ok" });
  });
});

describe("autenticación (HU-ACC-001)", () => {
  it("rechaza una clave incorrecta sin revelar qué dato falló", async () => {
    const mala = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "jefe", clave: "incorrecta" } });
    const inexistente = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "nadie", clave: "x" } });
    expect(mala.statusCode).toBe(401);
    expect(inexistente.statusCode).toBe(401);
    expect(mala.json()).toEqual(inexistente.json());
  });

  it("abre sesión con credenciales válidas y fija una cookie httpOnly", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "jefe", clave: "Demo2026!" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().rol).toBe("JEFE_BODEGA");
    expect(String(r.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("no expone ninguna función sin sesión (RNF-SEG-001)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/catalogo/referencias" });
    expect(r.statusCode).toBe(401);
  });
});

describe("catálogo", () => {
  it("lista las referencias con sus SKU para un usuario con sesión", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "auxiliar1", clave: "Demo2026!" } });
    const token = login.cookies.find((c) => c.name === "token")!.value;
    const r = await app.inject({ method: "GET", url: "/api/catalogo/referencias", cookies: { token } });
    expect(r.statusCode).toBe(200);
    const lista = r.json() as Array<{ codigo: string; skus: number }>;
    expect(lista.length).toBeGreaterThan(10);
    expect(lista.every((x) => x.skus > 0)).toBe(true);
  });

  it("la carga de los datos ficticios es idempotente", async () => {
    const antes = await prisma.sku.count();
    await cargarExcel(resolve(process.cwd(), "../../data/datos_ficticios.xlsx"));
    expect(await prisma.sku.count()).toBe(antes);
  });
});
