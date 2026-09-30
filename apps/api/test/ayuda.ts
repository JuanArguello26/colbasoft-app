import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Rol } from "@colbasoft/shared";
import { construirApp } from "../src/app.js";
import { cargarExcel } from "../src/datos/cargar-excel.js";

export const CLAVE_DEMO = "Demo2026!";

export async function iniciarApp(): Promise<FastifyInstance> {
  await cargarExcel(resolve(process.cwd(), "../../data/datos_ficticios.xlsx"));
  return construirApp({ jwtSecret: "secreto-de-prueba" });
}

/** Inicia sesión y devuelve el valor de la cookie. */
export async function entrar(app: FastifyInstance, login: string, clave = CLAVE_DEMO): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login, clave } });
  if (r.statusCode !== 200) throw new Error(`No se pudo iniciar sesión como ${login}: ${r.statusCode} ${r.body}`);
  return r.cookies.find((c) => c.name === "token")!.value;
}

export const pedir = (app: FastifyInstance, token: string, metodo: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method: metodo, url, cookies: { token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

let n = 0;
export const unico = (prefijo: string) => `${prefijo}${Date.now().toString(36)}${n++}`;

/** Crea un usuario nuevo por la API (como Administrador) y devuelve sus credenciales temporales. */
export async function usuarioNuevo(app: FastifyInstance, admin: string, rol: Rol) {
  const login = unico("u");
  const r = await pedir(app, admin, "POST", "/api/usuarios", { login, nombre: `Persona ${login}`, rol });
  if (r.statusCode !== 201) throw new Error(`No se pudo crear el usuario: ${r.body}`);
  const cuerpo = r.json() as { usuario: { id: string }; claveTemporal: string };
  return { login, id: cuerpo.usuario.id, claveTemporal: cuerpo.claveTemporal };
}

/** Crea un usuario y lo deja listo para operar (con la contraseña ya cambiada). */
export async function usuarioListo(app: FastifyInstance, admin: string, rol: Rol) {
  const u = await usuarioNuevo(app, admin, rol);
  const t = await entrar(app, u.login, u.claveTemporal);
  const nueva = "ClaveNueva2026!";
  const r = await pedir(app, t, "POST", "/api/auth/cambiar-clave", { claveActual: u.claveTemporal, claveNueva: nueva });
  if (r.statusCode !== 200) throw new Error(`No se pudo cambiar la clave: ${r.body}`);
  return { ...u, clave: nueva, token: await entrar(app, u.login, nueva) };
}
