import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { Rol, UsuarioSesion } from "@colbasoft/shared";
import { prisma } from "./db.js";
import { registrarSuelto } from "./bitacora.js";
import { emitirSesion } from "./sesion.js";
import { rutasAuth } from "./routes/auth.js";
import { rutasBitacora } from "./routes/bitacora.js";
import { rutasBodega } from "./routes/bodega.js";
import { rutasCatalogo } from "./routes/catalogo.js";
import { rutasEntradas } from "./routes/entradas.js";
import { rutasInventario } from "./routes/inventario.js";
import { rutasIdentificadores } from "./routes/identificadores.js";
import { rutasLotes } from "./routes/lotes.js";
import { rutasMovimientos } from "./routes/movimientos.js";
import { rutasMotivos } from "./routes/motivos.js";
import { rutasParametros } from "./routes/parametros.js";
import { rutasSalud } from "./routes/salud.js";
import { rutasUsuarios } from "./routes/usuarios.js";

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

/** Rutas que no cuentan como actividad: consultar el estado de la sesión no la prolonga. */
const PASIVAS = ["/api/auth/yo", "/api/salud"];
/** Con cambio de contraseña pendiente, solo se permiten estas rutas (HU-USR-001 criterio 5). */
const PERMITIDAS_CON_CAMBIO_PENDIENTE = ["/api/auth/yo", "/api/auth/cambiar-clave", "/api/auth/logout"];

export async function construirApp(opciones: OpcionesApp): Promise<FastifyInstance> {
  const app = Fastify({ logger: opciones.logger ?? false });

  await app.register(cookie);
  await app.register(jwt, { secret: opciones.jwtSecret, cookie: { cookieName: "token", signed: false } });

  // Ninguna función es accesible sin sesión válida (RNF-SEG-001). Se revisa contra la base de datos en cada petición:
  // desactivar o bloquear a un usuario cierra su acceso de inmediato (RF-USR-004).
  app.decorate("autenticar", async (req: FastifyRequest, reply: FastifyReply) => {
    const ruta = req.url.split("?")[0] ?? "";
    try {
      await req.jwtVerify();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED") {
        const token = req.cookies.token;
        const previo = token ? app.jwt.decode<UsuarioSesion>(token) : null;
        if (previo) {
          await registrarSuelto({
            actor: { tipo: "USUARIO", usuarioId: previo.id, usuarioLogin: previo.login },
            modulo: "ACCESO",
            evento: "sesion_cerrada_inactividad",
            origen: req.ip,
          });
        }
        reply.clearCookie("token", { path: "/" });
        return reply.code(401).send({ error: "La sesión se cerró por inactividad." });
      }
      return reply.code(401).send({ error: "Sesión no válida. Inicie sesión." });
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: req.user.id } });
    if (!usuario || !usuario.activo || usuario.bloqueado) {
      reply.clearCookie("token", { path: "/" });
      return reply.code(401).send({ error: "Sesión no válida. Inicie sesión." });
    }
    // El rol vigente es el de la base de datos, no el del token.
    const exp = (req.user as unknown as { exp?: number }).exp;
    req.user = Object.assign({ id: usuario.id, login: usuario.login, nombre: usuario.nombre, rol: usuario.rol }, { exp });

    if (usuario.debeCambiarClave && !PERMITIDAS_CON_CAMBIO_PENDIENTE.includes(ruta)) {
      return reply.code(403).send({ error: "Debe cambiar su contraseña antes de continuar.", codigo: "CAMBIAR_CLAVE" });
    }
    if (!PASIVAS.includes(ruta)) await emitirSesion(app, reply, req.user);
  });

  await app.register(rutasSalud, { prefix: "/api" });
  await app.register(rutasAuth, { prefix: "/api/auth" });
  await app.register(rutasUsuarios, { prefix: "/api/usuarios" });
  await app.register(rutasCatalogo, { prefix: "/api/catalogo" });
  await app.register(rutasBodega, { prefix: "/api/bodega" });
  await app.register(rutasLotes, { prefix: "/api/lotes" });
  await app.register(rutasIdentificadores, { prefix: "/api/identificadores" });
  await app.register(rutasEntradas, { prefix: "/api/entradas" });
  await app.register(rutasInventario, { prefix: "/api/inventario" });
  await app.register(rutasMovimientos, { prefix: "/api/movimientos" });
  await app.register(rutasParametros, { prefix: "/api/parametros" });
  await app.register(rutasMotivos, { prefix: "/api/motivos" });
  await app.register(rutasBitacora, { prefix: "/api/bitacora" });
  return app;
}

export type { Rol };
