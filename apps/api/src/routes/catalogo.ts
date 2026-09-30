import type { FastifyPluginAsync } from "fastify";
import type { ReferenciaResumen } from "@colbasoft/shared";
import { prisma } from "../db.js";

export const rutasCatalogo: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);

  app.get("/referencias", async (): Promise<ReferenciaResumen[]> => {
    const filas = await prisma.referencia.findMany({
      orderBy: { codigo: "asc" },
      include: { categoria: true, _count: { select: { skus: true } } },
    });
    return filas.map((r) => ({
      id: r.id,
      codigo: r.codigo,
      descripcion: r.descripcion,
      categoria: r.categoria.nombre,
      unidadMedida: r.unidadMedida,
      activa: r.activa,
      skus: r._count.skus,
    }));
  });
};
