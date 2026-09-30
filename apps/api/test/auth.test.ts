import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { CLAVE_DEMO, entrar, iniciarApp, pedir, unico, usuarioListo, usuarioNuevo } from "./ayuda.js";

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

const eventos = (login: string, evento: string) => prisma.registroBitacora.count({ where: { usuarioLogin: login, evento } });

describe("salud", () => {
  it("responde y ve la base de datos", async () => {
    const r = await app.inject({ method: "GET", url: "/api/salud" });
    expect(r.json()).toEqual({ estado: "ok", baseDeDatos: "ok" });
  });
});

describe("HU-ACC-001 · iniciar sesión", () => {
  it("criterio 4: un fallo no revela si el error fue del usuario o de la contraseña", async () => {
    const mala = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "jefe", clave: "incorrecta" } });
    const inexistente = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "nadie", clave: "x" } });
    expect(mala.statusCode).toBe(401);
    expect(mala.json()).toEqual(inexistente.json());
  });

  it("criterio 3: el acceso exitoso y el fallido quedan en la bitácora, con origen", async () => {
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "auditor", clave: "mala" } });
    await entrar(app, "auditor");
    expect(await eventos("auditor", "acceso_fallido")).toBeGreaterThan(0);
    expect(await eventos("auditor", "acceso_exitoso")).toBeGreaterThan(0);
    const r = await prisma.registroBitacora.findFirst({ where: { usuarioLogin: "auditor", evento: "acceso_exitoso" }, orderBy: { seq: "desc" } });
    expect(r?.origen).toBeTruthy();
  });

  it("criterio 5: tras el número configurado de intentos fallidos la cuenta se bloquea", async () => {
    const u = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: "incorrecta1" } });
      expect(r.statusCode).toBe(401);
    }
    const fila = await prisma.usuario.findUniqueOrThrow({ where: { login: u.login } });
    expect(fila.bloqueado).toBe(true);
    // ni siquiera con la clave correcta
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: u.clave } });
    expect(r.statusCode).toBe(401);
    expect(await eventos(u.login, "cuenta_bloqueada")).toBe(0); // el evento lo escribe el Sistema, sin login de usuario
    expect(await prisma.registroBitacora.count({ where: { evento: "cuenta_bloqueada", entidadId: u.id, actorTipo: "SISTEMA" } })).toBe(1);
  });

  it("el Administrador puede desbloquear la cuenta y el usuario debe cambiar su clave", async () => {
    const u = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: "incorrecta1" } });
    const d = await pedir(app, admin, "POST", `/api/usuarios/${u.id}/desbloquear`);
    expect(d.statusCode).toBe(200);
    const temporal = (d.json() as { claveTemporal: string }).claveTemporal;
    const tok = await entrar(app, u.login, temporal);
    expect((await pedir(app, tok, "GET", "/api/catalogo/referencias")).statusCode).toBe(403);
  });

  it("un acceso correcto reinicia el contador de intentos", async () => {
    const u = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: "incorrecta1" } });
    await entrar(app, u.login, u.clave);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { login: u.login } })).intentosFallidos).toBe(0);
  });
});

describe("HU-USR-001 criterio 5 · cambio de contraseña en el primer acceso", () => {
  it("con el cambio pendiente solo se permite cambiar la clave", async () => {
    const u = await usuarioNuevo(app, admin, "COORDINADOR_BODEGA");
    const tok = await entrar(app, u.login, u.claveTemporal);
    const bloqueada = await pedir(app, tok, "GET", "/api/catalogo/referencias");
    expect(bloqueada.statusCode).toBe(403);
    expect(bloqueada.json().codigo).toBe("CAMBIAR_CLAVE");

    const r = await pedir(app, tok, "POST", "/api/auth/cambiar-clave", { claveActual: u.claveTemporal, claveNueva: "ClaveSegura2026!" });
    expect(r.statusCode).toBe(200);
    expect((await pedir(app, tok, "GET", "/api/catalogo/referencias")).statusCode).toBe(200);
  });

  it("rechaza una contraseña débil, igual a la actual o que contiene el usuario", async () => {
    const u = await usuarioNuevo(app, admin, "COORDINADOR_BODEGA");
    const tok = await entrar(app, u.login, u.claveTemporal);
    const cambia = (claveNueva: string) => pedir(app, tok, "POST", "/api/auth/cambiar-clave", { claveActual: u.claveTemporal, claveNueva });
    expect((await cambia("corta1")).statusCode).toBe(422);
    expect((await cambia("soloLetrasAquí")).statusCode).toBe(422);
    expect((await cambia(`${u.login}12345`)).statusCode).toBe(422);
    expect((await cambia(u.claveTemporal)).statusCode).toBe(422);
  });
});

describe("HU-ACC-002 · sesión e inactividad", () => {
  it("consultar el estado no prolonga la sesión, pero operar sí", async () => {
    const tok = await entrar(app, "jefe");
    const yo1 = (await pedir(app, tok, "GET", "/api/auth/yo")).json() as { expiraEn: number; avisoSegundos: number };
    expect(yo1.avisoSegundos).toBeGreaterThan(0);
    const yo2 = (await pedir(app, tok, "GET", "/api/auth/yo")).json() as { expiraEn: number };
    expect(yo2.expiraEn).toBe(yo1.expiraEn);
  });

  it("criterio 5: un token vencido cierra la sesión y queda en la bitácora", async () => {
    const jefe = await prisma.usuario.findUniqueOrThrow({ where: { login: "jefe" } });
    const tokenCorto = app.jwt.sign({ id: jefe.id, login: jefe.login, nombre: jefe.nombre, rol: jefe.rol }, { expiresIn: 1 });
    await new Promise((r) => setTimeout(r, 2200));
    const antes = await eventos("jefe", "sesion_cerrada_inactividad");
    const r = await pedir(app, tokenCorto, "GET", "/api/catalogo/referencias");
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toContain("inactividad");
    expect(await eventos("jefe", "sesion_cerrada_inactividad")).toBe(antes + 1);
  });

  it("cerrar sesión queda registrado", async () => {
    const tok = await entrar(app, "coordinador");
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { token: tok } });
    expect(r.statusCode).toBe(200);
    expect(await eventos("coordinador", "sesion_cerrada")).toBeGreaterThan(0);
  });
});

describe("RNF-SEG-001 · sin sesión no hay acceso", () => {
  it.each(["/api/catalogo/referencias", "/api/bodega", "/api/usuarios", "/api/parametros", "/api/motivos", "/api/bitacora"])("%s responde 401", async (ruta) => {
    expect((await app.inject({ method: "GET", url: ruta })).statusCode).toBe(401);
  });
  it("sin credenciales guardadas en claro (RNF-SEG-002)", async () => {
    const fila = await prisma.usuario.findUniqueOrThrow({ where: { login: "admin" } });
    expect(fila.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(fila.passwordHash).not.toContain(CLAVE_DEMO);
    unico("x");
  });
});
