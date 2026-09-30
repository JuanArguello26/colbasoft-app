import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RegistroBitacoraVista } from "@colbasoft/shared";
import { consultar, registrarSuelto, verificarContinuidad } from "../bitacora.js";
import { requiereRol } from "../permisos.js";

/** El Jefe consulta la bitácora sin los eventos de configuración del sistema (SPEC §2.7). */
const MODULOS_DE_CONFIGURACION = ["PARAMETROS", "MOTIVOS", "USUARIOS"];
const lectores = requiereRol("ADMINISTRADOR", "AUDITOR", "JEFE_BODEGA");
const exportadores = requiereRol("ADMINISTRADOR", "AUDITOR");

const filtros = z.object({
  usuario: z.string().optional(),
  evento: z.string().optional(),
  modulo: z.string().optional(),
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
  limite: z.coerce.number().int().min(1).max(5000).optional(),
});

const vista = (r: Awaited<ReturnType<typeof consultar>>[number]): RegistroBitacoraVista => ({
  seq: String(r.seq), instante: r.instante.toISOString(), actorTipo: r.actorTipo, usuarioLogin: r.usuarioLogin, modulo: r.modulo,
  evento: r.evento, entidad: r.entidad, entidadId: r.entidadId, detalle: r.detalle, origen: r.origen,
});

const csv = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

export const rutasBitacora: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: lectores }, async (req, reply) => {
    const f = filtros.safeParse(req.query);
    if (!f.success) return reply.code(422).send({ error: "Filtros no válidos." });
    const excluir = req.user.rol === "JEFE_BODEGA" ? MODULOS_DE_CONFIGURACION : undefined;
    return (await consultar({ ...f.data, ...(excluir ? { excluirModulos: excluir } : {}) })).map(vista);
  });

  /** HU-AUD-001 criterio 5: exportable. La exportación queda registrada (RF-AUD-001). */
  app.get("/exportar", { preHandler: exportadores }, async (req, reply) => {
    const f = filtros.safeParse(req.query);
    if (!f.success) return reply.code(422).send({ error: "Filtros no válidos." });
    const filas = (await consultar({ ...f.data, limite: 5000 })).map(vista);
    await registrarSuelto({
      actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login },
      modulo: "BITACORA",
      evento: "bitacora_exportada",
      detalle: { filas: filas.length, filtros: JSON.parse(JSON.stringify(f.data)) },
      origen: req.ip,
    });
    const cabecera = ["seq", "instante", "actor", "usuario", "modulo", "evento", "entidad", "entidad_id", "origen", "detalle"];
    const lineas = filas.map((r) => [r.seq, r.instante, r.actorTipo, r.usuarioLogin, r.modulo, r.evento, r.entidad, r.entidadId, r.origen, JSON.stringify(r.detalle)].map(csv).join(","));
    reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="bitacora.csv"');
    return [cabecera.map(csv).join(","), ...lineas].join("\n");
  });

  /** HU-AUD-001 criterio 4: toda discontinuidad es un hallazgo crítico. */
  app.get("/continuidad", { preHandler: exportadores }, async () => verificarContinuidad());
};
