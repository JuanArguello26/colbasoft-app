import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ExistenciaReferencia, KardexVista, PiezasDeLoteVista, UbicacionDeReferencia } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar, registrarSuelto } from "../bitacora.js";
import { consultarExistencia, consultarKardex, dondeEsta, type FiltroKardex } from "../consultas.js";
import { existenciaDePiezas } from "../inventario.js";
import { requiereRol } from "../permisos.js";
import { skuVista } from "./lotes.js";

/** Matriz de permisos: anular un movimiento confirmado = Administrador y Jefe; consultar el kardex = todos, y el Auxiliar solo lo suyo. */
const anula = requiereRol("ADMINISTRADOR", "JEFE_BODEGA");
/** Matriz de permisos (SRS §3.3, «Consultar kardex»): el Auxiliar ve solo lo que él movió y los últimos 30 días. */
const DIAS_KARDEX_AUXILIAR = 30;

class ErrorHttp extends Error {
  constructor(public estado: number, mensaje: string) { super(mensaje); }
}
type Manejador = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const manejar = (f: Manejador): Manejador => async (req, reply) => {
  try { return await f(req, reply); }
  catch (e) {
    if (e instanceof ErrorHttp) return reply.code(e.estado).send({ error: e.message });
    if (e instanceof Error && e.message.includes("(RN-EXI-001)")) {
      return reply.code(409).send({ error: "La anulación dejaría la existencia por debajo de cero: la mercancía ya se movió. Anule primero los movimientos posteriores." });
    }
    throw e;
  }
};

const id = z.string().min(1);
const texto = z.string().trim().min(1).max(60);
const filtroExistencia = z.object({ q: texto.optional(), referenciaId: id.optional(), skuId: id.optional(), loteId: id.optional(), ubicacionId: id.optional() });
const filtroDondeEsta = z.object({ referenciaId: id, talla: texto.optional(), color: texto.optional(), lote: texto.optional(), orden: z.enum(["cantidad", "zona"]).default("cantidad") });
const filtroKardex = z.object({ piezaId: id.optional(), skuId: id.optional(), loteId: id.optional(), ubicacionId: id.optional(), formato: z.enum(["json", "csv"]).default("json") })
  .refine((f) => f.piezaId || f.skuId || f.loteId, "Indique la pieza, el lote o el SKU cuyo kardex quiere consultar.");
const anular = z.object({ motivoId: id });

const csv = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

export const rutasInventario: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });

  /** HU-INV-001 (RF-INV-001/002/003): existencia por referencia, SKU, lote o ubicación; derivada del kardex, sin escribir nada. */
  app.get("/existencia", manejar(async (req, reply): Promise<ExistenciaReferencia[] | void> => {
    const f = filtroExistencia.safeParse(req.query);
    if (!f.success) return reply.code(422).send({ error: "Filtros no válidos." });
    return consultarExistencia(f.data);
  }));

  /** HU-INV-003 (RF-INV-004): todas las ubicaciones con existencia de una referencia. */
  app.get("/donde-esta", manejar(async (req, reply): Promise<UbicacionDeReferencia[] | void> => {
    const f = filtroDondeEsta.safeParse(req.query);
    if (!f.success) return reply.code(422).send({ error: "Indique la referencia que busca." });
    return dondeEsta(f.data);
  }));

  /** HU-KDX-006 criterio 1 (RF-INV-009): las piezas de un lote con tipo, cantidad actual, ubicación y estado. */
  app.get("/lotes/:loteId/piezas", manejar(async (req, reply): Promise<PiezasDeLoteVista | void> => {
    const lote = await prisma.lote.findUnique({ where: { id: (req.params as { loteId: string }).loteId }, include: { sku: { include: { referencia: true, talla: true, color: true } } } });
    if (!lote) return reply.code(404).send({ error: "Lote no encontrado." });
    const piezas = await prisma.pieza.findMany({ where: { linea: { loteId: lote.id } }, orderBy: { numero: "asc" } });
    const donde = await existenciaDePiezas(piezas.map((p) => p.id));
    const usuarios = new Map((await prisma.usuario.findMany({ where: { id: { in: [...new Set(piezas.map((p) => p.registradaPorId))] } }, select: { id: true, login: true } })).map((u) => [u.id, u.login]));
    return {
      lote: { id: lote.id, codigo: lote.codigo, sku: skuVista(lote.sku) },
      piezas: piezas.map((p) => {
        const ubicaciones = donde.get(p.id) ?? [];
        return {
          id: p.id, numero: p.numero, tipo: p.tipo, cantidad: Number(p.cantidad), registradaPor: usuarios.get(p.registradaPorId) ?? "", registradaEn: p.registradaEn.toISOString(),
          ubicaciones, cantidadActual: ubicaciones.reduce((s, u) => s + u.cantidad, 0),
        };
      }),
    };
  }));

  /**
   * HU-KDX-001 y HU-KDX-006 (RF-KDX-001/002/008): el kardex de una pieza, o de una unidad de inventario (SKU + lote + ubicación), en orden
   * cronológico; exportable (criterio 5), y la exportación queda en la bitácora.
   */
  app.get("/kardex", manejar(async (req, reply): Promise<KardexVista | string | void> => {
    const f = filtroKardex.safeParse(req.query);
    if (!f.success) return reply.code(422).send({ error: f.error.issues[0]?.message ?? "Filtros no válidos." });
    const { formato, ...alcance } = f.data;
    const filtro: FiltroKardex = { ...alcance };
    if (req.user.rol === "AUXILIAR_BODEGA") {
      filtro.soloUsuarioId = req.user.id;
      filtro.desde = new Date(Date.now() - DIAS_KARDEX_AUXILIAR * 24 * 3600 * 1000);
    }
    const kardex = await consultarKardex(filtro);
    if (formato === "json") return kardex;
    await registrarSuelto({ actor: actor(req), modulo: "KARDEX", evento: "kardex_exportado", detalle: { lineas: kardex.lineas.length, ...alcance }, origen: req.ip });
    const cabecera = ["secuencia", "fecha_hora", "tipo", "cantidad", "existencia_resultante", "estado", "ubicacion", "pieza", "referencia", "talla", "color", "lote", "usuario", "documento", "motivo", "anula_a", "anulado_por"];
    const filas = kardex.lineas.map((l) => [l.secuencia, l.instante, l.tipo, l.cantidad, l.existenciaResultante, l.estado, l.ubicacion, l.pieza, l.sku.referencia, l.sku.talla, l.sku.color, l.lote, l.usuario, l.documento, l.motivo, l.anulaA, l.anuladoPor].map(csv).join(","));
    reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="kardex.csv"');
    return `﻿${[cabecera.map(csv).join(","), ...filas].join("\n")}`;
  }));

  /**
   * HU-KDX-002 / RF-KDX-004: un error no se edita ni se borra (no hay ninguna ruta que lo haga): se neutraliza con un movimiento inverso, con motivo
   * tipificado, y ambos quedan en el kardex. Un movimiento se anula una sola vez y una anulación no se anula (el error de una anulación se corrige
   * con el movimiento que corresponda). Si la mercancía ya se movió, la base rechaza dejar la existencia por debajo de cero.
   */
  app.post("/movimientos/:movimientoId/anular", { preHandler: anula }, manejar(async (req, reply) => {
    const d = anular.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: "Indique el motivo de la anulación." });
    const movimientoId = (req.params as { movimientoId: string }).movimientoId;
    const resultado = await prisma.$transaction(async (tx) => {
      const original = await tx.movimiento.findUnique({ where: { id: movimientoId }, include: { asientos: true, anuladoPor: { select: { secuencia: true } } } });
      if (!original) throw new ErrorHttp(404, "Movimiento no encontrado.");
      if (original.tipo === "ANULACION") throw new ErrorHttp(409, "Una anulación no se anula.");
      if (original.anuladoPor) throw new ErrorHttp(409, `El movimiento ya fue anulado por el movimiento ${original.anuladoPor.secuencia}.`);
      const motivo = await tx.motivo.findUnique({ where: { id: d.data.motivoId } });
      if (!motivo || motivo.tipoOperacion !== "ANULACION") throw new ErrorHttp(422, "Elija un motivo de anulación de la lista.");
      if (!motivo.activo) throw new ErrorHttp(422, "Ese motivo está desactivado.");
      const ahora = new Date();
      const inverso = await tx.movimiento.create({
        data: {
          tipo: "ANULACION", anulaAId: original.id, motivoId: motivo.id, documentoEntradaId: original.documentoEntradaId,
          usuarioId: req.user.id, usuarioLogin: req.user.login, iniciadoEn: ahora, confirmadoEn: ahora,
          // Mismo lugar, mismo estado, cantidad contraria: la suma de ambos movimientos es cero.
          asientos: { create: original.asientos.map((a) => ({ piezaId: a.piezaId, ubicacionId: a.ubicacionId, estado: a.estado, delta: a.delta.negated() })) },
        },
      });
      await registrar(tx, {
        actor: actor(req), modulo: "KARDEX", evento: "movimiento_anulado", entidad: "Movimiento", entidadId: original.id,
        detalle: { movimientoAnulado: original.secuencia, movimientoInverso: inverso.secuencia, tipoOriginal: original.tipo, motivo: motivo.nombre, asientos: original.asientos.length }, origen: req.ip,
      });
      return { anulado: original.secuencia, inverso: inverso.secuencia, movimientoId: inverso.id };
    });
    return reply.code(201).send(resultado);
  }));
};
