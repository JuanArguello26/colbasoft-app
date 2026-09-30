import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../db.js";

export const rutasSalud: FastifyPluginAsync = async (app) => {
  app.get("/salud", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { estado: "ok", baseDeDatos: "ok" };
    } catch {
      return reply.code(503).send({ estado: "degradado", baseDeDatos: "sin conexión" });
    }
  });
};
