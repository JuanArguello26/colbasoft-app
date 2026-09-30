import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { Rol, UsuarioSesion } from "@colbasoft/shared";
import { rutasAuth } from "./routes/auth.js";
import { rutasCatalogo } from "./routes/catalogo.js";
import { rutasSalud } from "./routes/salud.js";

declare module "fastify" {
  interface FastifyInstance {
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: UsuarioSesion;
    user: UsuarioSesion;
  }
}

export interface OpcionesApp {
  jwtSecret: string;
  logger?: boolean;
}

export async function construirApp(opciones: OpcionesApp): Promise<FastifyInstance> {
  const app = Fastify({ logger: opciones.logger ?? false });

  await app.register(cookie);
  await app.register(jwt, { secret: opciones.jwtSecret, cookie: { cookieName: "token", signed: false } });

  // Ninguna función es accesible sin sesión válida (RNF-SEG-001).
  app.decorate("autenticar", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Sesión no válida. Inicie sesión." });
    }
  });

  await app.register(rutasSalud, { prefix: "/api" });
  await app.register(rutasAuth, { prefix: "/api/auth" });
  await app.register(rutasCatalogo, { prefix: "/api/catalogo" });
  return app;
}

export type { Rol };
