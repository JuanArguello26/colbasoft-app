import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verificarClave } from "../seguridad.js";
import type { UsuarioSesion } from "@colbasoft/shared";

const cuerpoLogin = z.object({ login: z.string().min(1), clave: z.string().min(1) });
const OCHO_HORAS = 8 * 60 * 60;

export const rutasAuth: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    const datos = cuerpoLogin.safeParse(req.body);
    // Mismo mensaje para cualquier fallo: no revela si el usuario o la clave fue el incorrecto (HU-ACC-001, criterio 4).
    const rechazo = () => reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    if (!datos.success) return rechazo();

    const usuario = await prisma.usuario.findUnique({ where: { login: datos.data.login } });
    if (!usuario || !usuario.activo || !verificarClave(datos.data.clave, usuario.passwordHash)) return rechazo();

    const sesion: UsuarioSesion = { id: usuario.id, login: usuario.login, nombre: usuario.nombre, rol: usuario.rol };
    const token = app.jwt.sign(sesion, { expiresIn: OCHO_HORAS });
    reply.setCookie("token", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: OCHO_HORAS });
    return sesion;
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie("token", { path: "/" });
    return { ok: true };
  });

  app.get("/yo", { preHandler: app.autenticar }, async (req) => req.user);
};
