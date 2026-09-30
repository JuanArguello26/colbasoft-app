import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UNIDADES_MEDIDA, type ReferenciaDetalle, type ReferenciaResumen } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { referenciaTieneExistencia, referenciaTieneMovimientos } from "../inventario.js";
import { requiereRol } from "../permisos.js";

const escribe = requiereRol("ADMINISTRADOR", "JEFE_BODEGA");
const nombre = z.object({ nombre: z.string().trim().min(1).max(60) });
const crearReferencia = z.object({
  codigo: z.string().trim().min(2).max(30).transform((c) => c.toUpperCase()),
  descripcion: z.string().trim().min(2).max(200),
  categoriaId: z.string().min(1),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  tallaIds: z.array(z.string()).min(1, "Asigne al menos una talla."),
  colorIds: z.array(z.string()).min(1, "Asigne al menos un color."),
});
const editarReferencia = z.object({
  descripcion: z.string().trim().min(2).max(200).optional(),
  categoriaId: z.string().min(1).optional(),
  unidadMedida: z.enum(UNIDADES_MEDIDA).optional(),
});

type FilaReferencia = { id: string; codigo: string; descripcion: string; unidadMedida: ReferenciaResumen["unidadMedida"]; activa: boolean; categoria: { nombre: string }; _count: { skus: number } };
const resumen = (r: FilaReferencia): ReferenciaResumen => ({ id: r.id, codigo: r.codigo, descripcion: r.descripcion, categoria: r.categoria.nombre, unidadMedida: r.unidadMedida, activa: r.activa, skus: r._count.skus });

export const rutasCatalogo: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });

  app.get("/referencias", async (): Promise<ReferenciaResumen[]> =>
    (await prisma.referencia.findMany({ orderBy: { codigo: "asc" }, include: { categoria: true, _count: { select: { skus: true } } } })).map(resumen));

  app.get("/referencias/:id", async (req, reply): Promise<ReferenciaDetalle | void> => {
    const { id } = req.params as { id: string };
    const r = await prisma.referencia.findUnique({ where: { id }, include: { categoria: true, _count: { select: { skus: true } }, skus: { include: { talla: true, color: true } } } });
    if (!r) return reply.code(404).send({ error: "Referencia no encontrada." });
    return { ...resumen(r), tallas: [...new Set(r.skus.map((s) => s.talla.nombre))], colores: [...new Set(r.skus.map((s) => s.color.nombre))] };
  });

  /** HU-CAT-001: código único (RN-002), tallas y colores, SKU generados automáticamente, activa al crearse. */
  app.post("/referencias", { preHandler: escribe }, async (req, reply) => {
    const d = crearReferencia.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    if (await prisma.referencia.findUnique({ where: { codigo: d.data.codigo } })) {
      return reply.code(409).send({ error: "Ya existe una referencia con ese código (activa o inactiva)." });
    }
    const [categoria, tallas, colores] = await Promise.all([
      prisma.categoria.findUnique({ where: { id: d.data.categoriaId } }),
      prisma.talla.findMany({ where: { id: { in: d.data.tallaIds } } }),
      prisma.color.findMany({ where: { id: { in: d.data.colorIds } } }),
    ]);
    if (!categoria || !categoria.activa) return reply.code(422).send({ error: "La categoría no existe o está desactivada." });
    if (tallas.length !== new Set(d.data.tallaIds).size) return reply.code(422).send({ error: "Alguna talla no existe en el conjunto de la empresa." });
    if (colores.length !== new Set(d.data.colorIds).size) return reply.code(422).send({ error: "Algún color no existe en el conjunto de la empresa." });

    const ref = await prisma.$transaction(async (tx) => {
      const nueva = await tx.referencia.create({ data: { codigo: d.data.codigo, descripcion: d.data.descripcion, categoriaId: categoria.id, unidadMedida: d.data.unidadMedida } });
      await tx.sku.createMany({ data: tallas.flatMap((t) => colores.map((c) => ({ referenciaId: nueva.id, tallaId: t.id, colorId: c.id }))) });
      await registrar(tx, { actor: actor(req), modulo: "CATALOGO", evento: "referencia_creada", entidad: "Referencia", entidadId: nueva.id, detalle: { codigo: nueva.codigo, unidadMedida: nueva.unidadMedida, skus: tallas.length * colores.length }, origen: req.ip });
      return tx.referencia.findUniqueOrThrow({ where: { id: nueva.id }, include: { categoria: true, _count: { select: { skus: true } } } });
    });
    return reply.code(201).send(resumen(ref));
  });

  /** HU-CAT-002: la unidad de medida no cambia si la referencia ya tiene movimientos (RN-004). */
  app.patch("/referencias/:id", { preHandler: escribe }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = editarReferencia.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    const previa = await prisma.referencia.findUnique({ where: { id } });
    if (!previa) return reply.code(404).send({ error: "Referencia no encontrada." });
    if (d.data.unidadMedida && d.data.unidadMedida !== previa.unidadMedida && (await referenciaTieneMovimientos(id))) {
      return reply.code(409).send({ error: "La unidad de medida no puede cambiarse: la referencia ya tiene movimientos registrados." });
    }
    if (d.data.categoriaId && !(await prisma.categoria.findFirst({ where: { id: d.data.categoriaId, activa: true } }))) {
      return reply.code(422).send({ error: "La categoría no existe o está desactivada." });
    }
    const ref = await prisma.$transaction(async (tx) => {
      await tx.referencia.update({ where: { id }, data: d.data });
      await registrar(tx, { actor: actor(req), modulo: "CATALOGO", evento: "referencia_modificada", entidad: "Referencia", entidadId: id, detalle: { codigo: previa.codigo, cambios: d.data }, origen: req.ip });
      return tx.referencia.findUniqueOrThrow({ where: { id }, include: { categoria: true, _count: { select: { skus: true } } } });
    });
    return resumen(ref);
  });

  for (const [ruta, activa, evento] of [["desactivar", false, "referencia_desactivada"], ["reactivar", true, "referencia_reactivada"]] as const) {
    app.post(`/referencias/:id/${ruta}`, { preHandler: escribe }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const previa = await prisma.referencia.findUnique({ where: { id } });
      if (!previa) return reply.code(404).send({ error: "Referencia no encontrada." });
      if (previa.activa === activa) return reply.code(409).send({ error: activa ? "La referencia ya está activa." : "La referencia ya está inactiva." });
      // RN-MAE-003: solo se desactiva con existencia cero. Nunca se elimina (RN-063).
      if (!activa && (await referenciaTieneExistencia(id))) return reply.code(409).send({ error: "No se puede desactivar una referencia con existencia." });
      await prisma.$transaction(async (tx) => {
        await tx.referencia.update({ where: { id }, data: { activa } });
        await registrar(tx, { actor: actor(req), modulo: "CATALOGO", evento, entidad: "Referencia", entidadId: id, detalle: { codigo: previa.codigo }, origen: req.ip });
      });
      return { ok: true };
    });
  }

  // Conjuntos de la empresa: categorías, tallas y colores.
  const conjuntos = [
    { ruta: "categorias", entidad: "Categoria", evento: "categoria_creada", listar: () => prisma.categoria.findMany({ orderBy: { nombre: "asc" } }), existe: (n: string) => prisma.categoria.findUnique({ where: { nombre: n } }), crear: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], n: string) => tx.categoria.create({ data: { nombre: n } }) },
    { ruta: "tallas", entidad: "Talla", evento: "talla_creada", listar: () => prisma.talla.findMany({ orderBy: { nombre: "asc" } }), existe: (n: string) => prisma.talla.findUnique({ where: { nombre: n } }), crear: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], n: string) => tx.talla.create({ data: { nombre: n } }) },
    { ruta: "colores", entidad: "Color", evento: "color_creado", listar: () => prisma.color.findMany({ orderBy: { nombre: "asc" } }), existe: (n: string) => prisma.color.findUnique({ where: { nombre: n } }), crear: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], n: string) => tx.color.create({ data: { nombre: n } }) },
  ];
  for (const c of conjuntos) {
    app.get(`/${c.ruta}`, async () => c.listar());
    app.post(`/${c.ruta}`, { preHandler: escribe }, async (req, reply) => {
      const d = nombre.safeParse(req.body);
      if (!d.success) return reply.code(422).send({ error: "Indique un nombre." });
      if (await c.existe(d.data.nombre)) return reply.code(409).send({ error: "Ya existe un valor con ese nombre." });
      const creado = await prisma.$transaction(async (tx) => {
        const fila = await c.crear(tx, d.data.nombre);
        await registrar(tx, { actor: actor(req), modulo: "CATALOGO", evento: c.evento, entidad: c.entidad, entidadId: fila.id, detalle: { nombre: fila.nombre }, origen: req.ip });
        return fila;
      });
      return reply.code(201).send(creado);
    });
  }
};
