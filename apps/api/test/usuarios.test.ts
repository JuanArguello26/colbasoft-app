import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico, usuarioListo, usuarioNuevo } from "./ayuda.js";

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

describe("HU-USR-001 · crear usuarios con uno de los cinco roles", () => {
  it("crea el usuario, devuelve la clave temporal una sola vez y lo registra en la bitácora (criterio 4)", async () => {
    const u = await usuarioNuevo(app, admin, "AUXILIAR_BODEGA");
    expect(u.claveTemporal.length).toBeGreaterThanOrEqual(10);
    const fila = await prisma.usuario.findUniqueOrThrow({ where: { login: u.login } });
    expect(fila.debeCambiarClave).toBe(true);
    expect(fila.passwordHash).not.toContain(u.claveTemporal);
    expect(await prisma.registroBitacora.count({ where: { evento: "usuario_creado", entidadId: u.id } })).toBe(1);
    // la lista nunca expone la contraseña
    const lista = (await pedir(app, admin, "GET", "/api/usuarios")).body;
    expect(lista).not.toContain("passwordHash");
    expect(lista).not.toContain(u.claveTemporal);
  });

  it("criterios 1 y 2: solo admite los cinco roles oficiales; no se puede inventar un rol", async () => {
    const r = await pedir(app, admin, "POST", "/api/usuarios", { login: unico("x"), nombre: "Persona Uno", rol: "SUPERUSUARIO" });
    expect(r.statusCode).toBe(422);
  });

  it("RN-014: el identificador es único en todo el sistema", async () => {
    const r = await pedir(app, admin, "POST", "/api/usuarios", { login: "admin", nombre: "Persona Dos", rol: "AUDITOR" });
    expect(r.statusCode).toBe(409);
  });

  it("solo el Administrador gestiona usuarios y el intento queda registrado (RNF-SEG-007)", async () => {
    const jefe = await entrar(app, "jefe");
    const antes = await prisma.registroBitacora.count({ where: { evento: "operacion_no_autorizada", usuarioLogin: "jefe" } });
    expect((await pedir(app, jefe, "GET", "/api/usuarios")).statusCode).toBe(403);
    expect((await pedir(app, jefe, "POST", "/api/usuarios", { login: unico("x"), nombre: "Persona Tres", rol: "AUDITOR" })).statusCode).toBe(403);
    expect(await prisma.registroBitacora.count({ where: { evento: "operacion_no_autorizada", usuarioLogin: "jefe" } })).toBe(antes + 2);
  });
});

describe("HU-USR-002 · desactivar usuarios", () => {
  it("cierra el acceso de inmediato, conserva al usuario y se puede reactivar (criterios 1, 3, 4, 5)", async () => {
    const u = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    expect((await pedir(app, u.token, "GET", "/api/catalogo/referencias")).statusCode).toBe(200);

    expect((await pedir(app, admin, "POST", `/api/usuarios/${u.id}/desactivar`)).statusCode).toBe(200);
    // el token sigue siendo válido, pero el acceso ya está cerrado
    expect((await pedir(app, u.token, "GET", "/api/catalogo/referencias")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: u.clave } })).statusCode).toBe(401);
    expect(await prisma.usuario.findUnique({ where: { id: u.id } })).not.toBeNull(); // no se elimina

    expect((await pedir(app, admin, "POST", `/api/usuarios/${u.id}/reactivar`)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: u.clave } })).statusCode).toBe(200);
    expect(await prisma.registroBitacora.count({ where: { entidadId: u.id, evento: { in: ["usuario_desactivado", "usuario_reactivado"] } } })).toBe(2);
  });

  it("no existe ninguna función para eliminar un usuario (RN-063)", async () => {
    const u = await usuarioNuevo(app, admin, "AUDITOR");
    expect((await app.inject({ method: "DELETE", url: `/api/usuarios/${u.id}`, cookies: { token: admin } })).statusCode).toBe(404);
  });

  it("RN-011: no se puede desactivar al último Administrador activo", async () => {
    const admins = await prisma.usuario.findMany({ where: { rol: "ADMINISTRADOR", activo: true } });
    // se desactivan todos menos uno; el último debe resistirse
    const otro = await usuarioNuevo(app, admin, "ADMINISTRADOR");
    for (const a of admins.filter((x) => x.login !== "admin")) await prisma.usuario.update({ where: { id: a.id }, data: { activo: false } });
    await prisma.usuario.update({ where: { id: otro.id }, data: { activo: false } });
    const adminFila = await prisma.usuario.findUniqueOrThrow({ where: { login: "admin" } });
    const r = await pedir(app, admin, "POST", `/api/usuarios/${adminFila.id}/desactivar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("último Administrador");
    await prisma.usuario.update({ where: { id: otro.id }, data: { activo: true } });
  });
});
