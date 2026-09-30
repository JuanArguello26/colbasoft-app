import type { FastifyInstance, FastifyReply } from "fastify";
import type { UsuarioSesion } from "@colbasoft/shared";
import { valorParametro } from "./parametros.js";

/** Emite la cookie de sesión. La vigencia es el tiempo de inactividad configurado en M-19 (HU-ACC-002). */
export async function emitirSesion(app: FastifyInstance, reply: FastifyReply, sesion: UsuarioSesion): Promise<number> {
  const minutos = await valorParametro("inactividad_sesion_minutos");
  const segundos = Math.round(minutos * 60);
  const token = app.jwt.sign(sesion, { expiresIn: segundos });
  reply.setCookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: segundos,
    secure: process.env.NODE_ENV === "production",
  });
  return Date.now() + segundos * 1000;
}
