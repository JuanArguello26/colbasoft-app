import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { definicion, listarParametros, validarValor } from "../parametros.js";
import { requiereRol } from "../permisos.js";

const cuerpo = z.object({ valor: z.number() });

export const rutasParametros: FastifyPluginAsync = async (app) => {
  /** Administrador y Jefe leen todos (DEC-04); el Coordinador solo consulta su propio umbral (RN-030). */
  app.get("/", { preHandler: requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA") }, async (req) => {
    const solo = req.user.rol === "COORDINADOR_BODEGA" ? ["umbral_autorizacion_coordinador"] : undefined;
    return listarParametros(solo);
  });

  /** RF-PAR-001 a 004: solo el Administrador modifica; valida rango; registra anterior y nuevo; rige hacia adelante. */
  app.put("/:clave", { preHandler: requiereRol("ADMINISTRADOR") }, async (req, reply) => {
    const { clave } = req.params as { clave: string };
    const def = definicion(clave);
    if (!def) return reply.code(404).send({ error: "Parámetro desconocido." });
    const datos = cuerpo.safeParse(req.body);
    if (!datos.success) return reply.code(422).send({ error: "El valor debe ser un número." });
    const problema = validarValor(def, datos.data.valor);
    if (problema) return reply.code(422).send({ error: problema });

    const anterior = (await prisma.parametro.findUnique({ where: { clave } }))?.valor ?? def.porDefecto;
    await prisma.$transaction(async (tx) => {
      await tx.parametro.upsert({ where: { clave }, update: { valor: datos.data.valor, actualizadoPor: req.user.id }, create: { clave, valor: datos.data.valor, actualizadoPor: req.user.id } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "PARAMETROS", evento: "parametro_modificado", entidad: "Parametro", entidadId: clave, detalle: { clave, anterior, nuevo: datos.data.valor }, origen: req.ip });
    });
    return { clave, anterior, nuevo: datos.data.valor };
  });
};
