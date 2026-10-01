import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UNIDADES_MEDIDA, ZONA_TIPOS, type BodegaVista } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { ubicacionTieneExistencia } from "../inventario.js";
import { requiereRol } from "../permisos.js";

const soloAdmin = requiereRol("ADMINISTRADOR");
const codigo = z.string().trim().min(1).max(20).transform((c) => c.toUpperCase());
const crearBodega = z.object({
  codigo,
  nombre: z.string().trim().min(2).max(80),
  // RN-019 y RN-EXI-007: toda bodega nace con una zona de recepción que tiene al menos una ubicación.
  zonaRecepcion: z.object({ codigo, nombre: z.string().trim().min(2).max(80), ubicacionCodigo: codigo }),
});
const crearZona = z.object({ codigo, nombre: z.string().trim().min(2).max(80), tipo: z.enum(ZONA_TIPOS) });
const capacidad = z.object({ capacidad: z.number().positive().nullable(), unidadCapacidad: z.enum(UNIDADES_MEDIDA).nullable() })
  .refine((c) => (c.capacidad === null) === (c.unidadCapacidad === null), "La capacidad y su unidad van juntas.");
const crearUbicacion = z.object({ codigo, capacidad: z.number().positive().optional(), unidadCapacidad: z.enum(UNIDADES_MEDIDA).optional() })
  .refine((c) => (c.capacidad === undefined) === (c.unidadCapacidad === undefined), "La capacidad y su unidad van juntas.");

export const rutasBodega: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });

  app.get("/", async (): Promise<BodegaVista[]> => {
    const bodegas = await prisma.bodega.findMany({ orderBy: { codigo: "asc" }, include: { zonas: { orderBy: { codigo: "asc" }, include: { categoria: true, ubicaciones: { orderBy: { codigo: "asc" } } } } } });
    return bodegas.map((b) => ({
      id: b.id, codigo: b.codigo, nombre: b.nombre,
      zonas: b.zonas.map((z) => ({ id: z.id, codigo: z.codigo, nombre: z.nombre, tipo: z.tipo, categoriaId: z.categoriaId, categoria: z.categoria?.nombre ?? null, ubicaciones: z.ubicaciones.map((u) => ({ id: u.id, codigo: u.codigo, activa: u.activa, capacidad: u.capacidad, unidadCapacidad: u.unidadCapacidad })) })),
    }));
  });

  /** HU-BOD-002 criterio 4: las ubicaciones sin capacidad son ilimitadas y se listan como pendientes de configurar. */
  app.get("/ubicaciones/pendientes-capacidad", async () =>
    (await prisma.ubicacion.findMany({ where: { capacidad: null, activa: true }, orderBy: { codigo: "asc" }, include: { zona: true } })).map((u) => ({ id: u.id, codigo: u.codigo, zona: u.zona.codigo })));

  app.post("/bodegas", { preHandler: soloAdmin }, async (req, reply) => {
    const d = crearBodega.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    if (await prisma.bodega.findUnique({ where: { codigo: d.data.codigo } })) return reply.code(409).send({ error: "Ya existe una bodega con ese código." });
    const id = await prisma.$transaction(async (tx) => {
      const b = await tx.bodega.create({ data: { codigo: d.data.codigo, nombre: d.data.nombre } });
      const z = await tx.zona.create({ data: { bodegaId: b.id, codigo: d.data.zonaRecepcion.codigo, nombre: d.data.zonaRecepcion.nombre, tipo: "RECEPCION" } });
      await tx.ubicacion.create({ data: { bodegaId: b.id, zonaId: z.id, codigo: d.data.zonaRecepcion.ubicacionCodigo } });
      await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento: "bodega_creada", entidad: "Bodega", entidadId: b.id, detalle: { codigo: b.codigo, zonaRecepcion: z.codigo }, origen: req.ip });
      return b.id;
    });
    return reply.code(201).send({ id });
  });

  app.post("/bodegas/:bodegaId/zonas", { preHandler: soloAdmin }, async (req, reply) => {
    const { bodegaId } = req.params as { bodegaId: string };
    const d = crearZona.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    if (!(await prisma.bodega.findUnique({ where: { id: bodegaId } }))) return reply.code(404).send({ error: "Bodega no encontrada." });
    if (await prisma.zona.findUnique({ where: { bodegaId_codigo: { bodegaId, codigo: d.data.codigo } } })) return reply.code(409).send({ error: "Ya existe una zona con ese código en la bodega." });
    // Una zona de recepción nace con al menos una ubicación (RN-EXI-007): se crea desde la pantalla de la bodega.
    if (d.data.tipo === "RECEPCION") return reply.code(422).send({ error: "Una zona de recepción nueva debe crearse junto con su primera ubicación; agréguela y luego cree la ubicación." });
    const z = await prisma.$transaction(async (tx) => {
      const nueva = await tx.zona.create({ data: { bodegaId, ...d.data } });
      await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento: "zona_creada", entidad: "Zona", entidadId: nueva.id, detalle: { codigo: nueva.codigo, tipo: nueva.tipo }, origen: req.ip });
      return nueva;
    });
    return reply.code(201).send({ id: z.id });
  });

  /** RN-MOV-001 / H-19: la categoría que recibe una zona alimenta el primer criterio de la propuesta de ubicación («zona por categoría»). */
  app.patch("/zonas/:id/categoria", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = z.object({ categoriaId: z.string().min(1).nullable() }).safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: "Indique la categoría o null para quitarla." });
    const zona = await prisma.zona.findUnique({ where: { id } });
    if (!zona) return reply.code(404).send({ error: "Zona no encontrada." });
    if (d.data.categoriaId && !(await prisma.categoria.findFirst({ where: { id: d.data.categoriaId, activa: true } }))) return reply.code(422).send({ error: "La categoría no existe o está desactivada." });
    await prisma.$transaction(async (tx) => {
      await tx.zona.update({ where: { id }, data: { categoriaId: d.data.categoriaId } });
      await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento: "zona_categoria_modificada", entidad: "Zona", entidadId: id, detalle: { zona: zona.codigo, anterior: zona.categoriaId, nueva: d.data.categoriaId }, origen: req.ip });
    });
    return { ok: true };
  });

  /** HU-BOD-001: el código de ubicación es único dentro de su bodega (RN-014). */
  app.post("/zonas/:zonaId/ubicaciones", { preHandler: soloAdmin }, async (req, reply) => {
    const { zonaId } = req.params as { zonaId: string };
    const d = crearUbicacion.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    const zona = await prisma.zona.findUnique({ where: { id: zonaId } });
    if (!zona) return reply.code(404).send({ error: "Zona no encontrada." });
    if (await prisma.ubicacion.findUnique({ where: { bodegaId_codigo: { bodegaId: zona.bodegaId, codigo: d.data.codigo } } })) return reply.code(409).send({ error: "Ya existe una ubicación con ese código en la bodega." });
    const u = await prisma.$transaction(async (tx) => {
      const nueva = await tx.ubicacion.create({ data: { bodegaId: zona.bodegaId, zonaId, codigo: d.data.codigo, capacidad: d.data.capacidad ?? null, unidadCapacidad: d.data.unidadCapacidad ?? null } });
      await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento: "ubicacion_creada", entidad: "Ubicacion", entidadId: nueva.id, detalle: { codigo: nueva.codigo, zona: zona.codigo }, origen: req.ip });
      return nueva;
    });
    return reply.code(201).send({ id: u.id });
  });

  app.patch("/ubicaciones/:id/capacidad", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = capacidad.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    const previa = await prisma.ubicacion.findUnique({ where: { id } });
    if (!previa) return reply.code(404).send({ error: "Ubicación no encontrada." });
    await prisma.$transaction(async (tx) => {
      await tx.ubicacion.update({ where: { id }, data: d.data });
      await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento: "capacidad_modificada", entidad: "Ubicacion", entidadId: id, detalle: { codigo: previa.codigo, anterior: { capacidad: previa.capacidad, unidad: previa.unidadCapacidad }, nuevo: d.data }, origen: req.ip });
    });
    return { ok: true };
  });

  for (const [ruta, activa, evento] of [["desactivar", false, "ubicacion_desactivada"], ["reactivar", true, "ubicacion_reactivada"]] as const) {
    app.post(`/ubicaciones/:id/${ruta}`, { preHandler: soloAdmin }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const u = await prisma.ubicacion.findUnique({ where: { id }, include: { zona: true } });
      if (!u) return reply.code(404).send({ error: "Ubicación no encontrada." });
      if (u.activa === activa) return reply.code(409).send({ error: activa ? "La ubicación ya está activa." : "La ubicación ya está desactivada." });
      if (!activa) {
        // RN-013: una ubicación con existencia no puede desactivarse. Nada se elimina (RN-063).
        if (await ubicacionTieneExistencia(id)) return reply.code(409).send({ error: "No se puede desactivar una ubicación con existencia." });
        // RN-EXI-007: la zona de recepción conserva al menos una ubicación activa.
        if (u.zona.tipo === "RECEPCION" && (await prisma.ubicacion.count({ where: { zonaId: u.zonaId, activa: true, id: { not: id } } })) === 0) {
          return reply.code(409).send({ error: "La zona de recepción debe conservar al menos una ubicación activa." });
        }
      }
      await prisma.$transaction(async (tx) => {
        await tx.ubicacion.update({ where: { id }, data: { activa } });
        await registrar(tx, { actor: actor(req), modulo: "BODEGA", evento, entidad: "Ubicacion", entidadId: id, detalle: { codigo: u.codigo }, origen: req.ip });
      });
      return { ok: true };
    });
  }
};
