import type { FastifyReply, FastifyRequest } from "fastify";

/** Un rechazo de negocio con su código HTTP y un mensaje que entiende quien opera. Se lanza dentro de la transacción para que deshaga todo. */
export class ErrorHttp extends Error {
  constructor(public estado: number, mensaje: string, public extra: object = {}) { super(mensaje); }
}

export type Manejador = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Envuelve una ruta: los ErrorHttp salen como respuesta; la regla de no-negativo de la base (RN-EXI-001) se explica con `mensajeSinExistencia`,
 * porque a esas alturas otra operación ya comprometió la existencia.
 */
export const manejador = (mensajeSinExistencia: string) => (f: Manejador): Manejador => async (req, reply) => {
  try { return await f(req, reply); }
  catch (e) {
    if (e instanceof ErrorHttp) return reply.code(e.estado).send({ error: e.message, ...e.extra });
    if (e instanceof Error && e.message.includes("(RN-EXI-001)")) return reply.code(409).send({ error: mensajeSinExistencia });
    throw e;
  }
};
