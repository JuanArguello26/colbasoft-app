import type { FastifyReply, FastifyRequest } from "fastify";
import type { Rol } from "@colbasoft/shared";
import { registrarSuelto } from "./bitacora.js";

/** Control de acceso por rol, aplicado al ejecutar la operación (RNF-SEG-003). */
export function requiereRol(...roles: Rol[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await req.server.autenticar(req, reply);
    if (reply.sent) return;
    if (!roles.includes(req.user.rol)) {
      // RNF-SEG-007: todo intento de operación no autorizada queda registrado.
      await registrarSuelto({
        actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login },
        modulo: "ACCESO",
        evento: "operacion_no_autorizada",
        detalle: { metodo: req.method, ruta: req.url.split("?")[0] ?? "", rol: req.user.rol },
        origen: req.ip,
      });
      reply.code(403).send({ error: "Su rol no puede realizar esta operación." });
    }
  };
}
