import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { TIPOS_OPERACION, type MotivoVista } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { requiereRol } from "../permisos.js";

const soloAdmin = requiereRol("ADMINISTRADOR");
const crear = z.object({ tipoOperacion: z.enum(TIPOS_OPERACION), nombre: z.string().trim().min(3).max(120), exigeEvidencia: z.boolean().default(false) });
const editar = z.object({ nombre: z.string().trim().min(3).max(120).optional(), exigeEvidencia: z.boolean().optional() });

const vista = (m: { id: string; tipoOperacion: MotivoVista["tipoOperacion"]; nombre: string; exigeEvidencia: boolean; activo: boolean }): MotivoVista => ({
  id: m.id, tipoOperacion: m.tipoOperacion, nombre: m.nombre, exigeEvidencia: m.exigeEvidencia, activo: m.activo,
});

export const rutasMotivos: FastifyPluginAsync = async (app) => {
  /** Todos los roles ven los motivos activos (para usarlos); el Administrador ve también los desactivados. */
  app.get("/", { preHandler: app.autenticar }, async (req) => {
    const where = req.user.rol === "ADMINISTRADOR" ? {} : { activo: true };
    return (await prisma.motivo.findMany({ where, orderBy: [{ tipoOperacion: "asc" }, { nombre: "asc" }] })).map(vista);
  });

  app.post("/", { preHandler: soloAdmin }, async (req, reply) => {
    const datos = crear.safeParse(req.body);
    if (!datos.success) return reply.code(422).send({ error: datos.error.issues[0]?.message ?? "Datos no válidos." });
    if (await prisma.motivo.findUnique({ where: { tipoOperacion_nombre: { tipoOperacion: datos.data.tipoOperacion, nombre: datos.data.nombre } } })) {
      return reply.code(409).send({ error: "Ya existe ese motivo para ese tipo de operación." });
    }
    const m = await prisma.$transaction(async (tx) => {
      const nuevo = await tx.motivo.create({ data: datos.data });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "MOTIVOS", evento: "motivo_creado", entidad: "Motivo", entidadId: nuevo.id, detalle: { ...datos.data }, origen: req.ip });
      return nuevo;
    });
    return reply.code(201).send(vista(m));
  });

  app.patch("/:id", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const datos = editar.safeParse(req.body);
    if (!datos.success) return reply.code(422).send({ error: datos.error.issues[0]?.message ?? "Datos no válidos." });
    const previo = await prisma.motivo.findUnique({ where: { id } });
    if (!previo) return reply.code(404).send({ error: "Motivo no encontrado." });
    const m = await prisma.$transaction(async (tx) => {
      const nuevo = await tx.motivo.update({ where: { id }, data: datos.data });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "MOTIVOS", evento: "motivo_modificado", entidad: "Motivo", entidadId: id, detalle: { anterior: { nombre: previo.nombre, exigeEvidencia: previo.exigeEvidencia }, nuevo: datos.data }, origen: req.ip });
      return nuevo;
    });
    return vista(m);
  });

  /** RN-063: un motivo no se elimina, se desactiva; el desactivado no aparece en operaciones nuevas pero sí en el histórico. */
  for (const [ruta, activo, evento] of [["desactivar", false, "motivo_desactivado"], ["reactivar", true, "motivo_reactivado"]] as const) {
    app.post(`/:id/${ruta}`, { preHandler: soloAdmin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const previo = await prisma.motivo.findUnique({ where: { id } });
      if (!previo) return reply.code(404).send({ error: "Motivo no encontrado." });
      if (previo.activo === activo) return reply.code(409).send({ error: activo ? "El motivo ya está activo." : "El motivo ya está desactivado." });
      await prisma.$transaction(async (tx) => {
        await tx.motivo.update({ where: { id }, data: { activo } });
        await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "MOTIVOS", evento, entidad: "Motivo", entidadId: id, detalle: { nombre: previo.nombre }, origen: req.ip });
      });
      return { ok: true };
    });
  }
};
