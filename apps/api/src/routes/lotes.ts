import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { LoteVista, SkuVista } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { requiereRol } from "../permisos.js";

/** Quien crea la entrada crea el lote (matriz de permisos: crear documento de entrada). */
const escribe = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA");
const crearLote = z.object({
  skuId: z.string().min(1),
  codigo: z.string().trim().min(1, "Indique el código del lote.").max(40).transform((c) => c.toUpperCase()),
  origen: z.string().trim().min(2, "Indique el origen del lote.").max(120),
});

const incluirSku = { referencia: true, talla: true, color: true } as const;
type FilaSku = { id: string; referencia: { codigo: string; descripcion: string; unidadMedida: SkuVista["unidadMedida"] }; talla: { nombre: string }; color: { nombre: string } };
export const skuVista = (s: FilaSku): SkuVista => ({ id: s.id, referencia: s.referencia.codigo, descripcion: s.referencia.descripcion, talla: s.talla.nombre, color: s.color.nombre, unidadMedida: s.referencia.unidadMedida });

const incluirLote = { sku: { include: incluirSku }, identificador: true } as const;
type FilaLote = Prisma.LoteGetPayload<{ include: typeof incluirLote }>;
const loteVista = (l: FilaLote): LoteVista => ({
  id: l.id, codigo: l.codigo, origen: l.origen, fechaIngreso: l.fechaIngreso.toISOString(), sku: skuVista(l.sku),
  identificador: l.identificador ? { id: l.identificador.id, codigo: l.identificador.codigo, estado: l.identificador.estado } : null,
});

export const rutasLotes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);

  /** SKU de referencias activas: lo que se puede recibir y, por tanto, lo que admite un lote. */
  app.get("/skus", async (): Promise<SkuVista[]> =>
    (await prisma.sku.findMany({ where: { referencia: { activa: true } }, include: incluirSku, orderBy: [{ referencia: { codigo: "asc" } }, { talla: { nombre: "asc" } }, { color: { nombre: "asc" } }] })).map(skuVista));

  /** HU-LOT-001 criterio 5: el lote aparece en toda consulta. */
  app.get("/", async (req): Promise<LoteVista[]> => {
    const { skuId, q } = req.query as { skuId?: string; q?: string };
    const texto = q?.trim();
    const filas = await prisma.lote.findMany({
      where: {
        ...(skuId ? { skuId } : {}),
        ...(texto ? { OR: [{ codigo: { contains: texto, mode: "insensitive" } }, { origen: { contains: texto, mode: "insensitive" } }, { sku: { referencia: { codigo: { contains: texto, mode: "insensitive" } } } }] } : {}),
      },
      include: incluirLote, orderBy: { fechaIngreso: "desc" }, take: 200,
    });
    return filas.map(loteVista);
  });

  app.get("/:id", async (req, reply): Promise<LoteVista | void> => {
    const l = await prisma.lote.findUnique({ where: { id: (req.params as { id: string }).id }, include: incluirLote });
    if (!l) return reply.code(404).send({ error: "Lote no encontrado." });
    return loteVista(l);
  });

  /** HU-LOT-001 criterios 1 a 3: el lote registra origen y fecha de ingreso; su código es único dentro del SKU (RN-MAE-006). */
  app.post("/", { preHandler: escribe }, async (req, reply) => {
    const d = crearLote.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    const sku = await prisma.sku.findUnique({ where: { id: d.data.skuId }, include: { referencia: true } });
    if (!sku) return reply.code(404).send({ error: "SKU no encontrado." });
    if (!sku.referencia.activa) return reply.code(422).send({ error: "La referencia de ese SKU está desactivada." });
    const duplicado = { error: "Ya existe un lote con ese código para este SKU." };
    if (await prisma.lote.findUnique({ where: { skuId_codigo: { skuId: sku.id, codigo: d.data.codigo } } })) return reply.code(409).send(duplicado);
    try {
      const lote = await prisma.$transaction(async (tx) => {
        const nuevo = await tx.lote.create({ data: { skuId: sku.id, codigo: d.data.codigo, origen: d.data.origen }, include: incluirLote });
        await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "LOTES", evento: "lote_creado", entidad: "Lote", entidadId: nuevo.id, detalle: { codigo: nuevo.codigo, skuId: sku.id, referencia: sku.referencia.codigo, origen: nuevo.origen }, origen: req.ip });
        return nuevo;
      });
      return reply.code(201).send(loteVista(lote));
    } catch (e) {
      // Dos peticiones simultáneas con el mismo código: la restricción única de la base decide.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return reply.code(409).send(duplicado);
      throw e;
    }
  });
};
