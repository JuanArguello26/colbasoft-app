import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

/**
 * Bitácora de auditoría (M-18, AG-16).
 * - Solo se agrega: la base de datos rechaza UPDATE, DELETE y TRUNCATE (migración c1_1_fundacion).
 * - Cada registro encadena el hash del anterior. Si alguien alterara o quitara un registro, la cadena se rompe y
 *   `verificarContinuidad` lo reporta como hallazgo crítico (HU-AUD-001 criterio 4).
 * - Nunca se escriben contraseñas ni claves en el detalle.
 */

export interface Actor {
  tipo: "USUARIO" | "SISTEMA";
  usuarioId?: string | null;
  usuarioLogin?: string | null;
}

export interface EventoBitacora {
  actor: Actor;
  modulo: string;
  evento: string;
  entidad?: string;
  entidadId?: string;
  detalle?: Prisma.InputJsonValue;
  origen?: string;
}

const CANDADO = 727001;
const GENESIS = "0".repeat(64);

type Cliente = Prisma.TransactionClient;

/** JSON con las llaves ordenadas: el mismo contenido da siempre el mismo texto (jsonb reordena llaves). */
export function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  const o = valor as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
}

function calcularHash(anterior: string, campos: unknown): string {
  return createHash("sha256").update(anterior).update(canonico(campos)).digest("hex");
}

function camposDe(e: EventoBitacora, instante: Date) {
  return {
    instante: instante.toISOString(),
    actorTipo: e.actor.tipo,
    usuarioId: e.actor.usuarioId ?? null,
    usuarioLogin: e.actor.usuarioLogin ?? null,
    modulo: e.modulo,
    evento: e.evento,
    entidad: e.entidad ?? null,
    entidadId: e.entidadId ?? null,
    detalle: e.detalle ?? null,
    origen: e.origen ?? null,
  };
}

/** Registra un evento dentro de la transacción `tx`: si la operación se revierte, el registro también. */
export async function registrar(tx: Cliente, e: EventoBitacora): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANDADO})`; // serializa la cadena
  const ultimo = await tx.registroBitacora.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } });
  const anterior = ultimo?.hash ?? GENESIS;
  const instante = new Date();
  const hash = calcularHash(anterior, camposDe(e, instante));
  await tx.registroBitacora.create({
    data: {
      instante,
      actorTipo: e.actor.tipo,
      usuarioId: e.actor.usuarioId ?? null,
      usuarioLogin: e.actor.usuarioLogin ?? null,
      modulo: e.modulo,
      evento: e.evento,
      entidad: e.entidad ?? null,
      entidadId: e.entidadId ?? null,
      detalle: e.detalle ?? undefined,
      origen: e.origen ?? null,
      hashAnterior: anterior,
      hash,
    },
  });
}

/** Registra un evento que no acompaña a otra escritura (p. ej. un acceso fallido). */
export async function registrarSuelto(e: EventoBitacora): Promise<void> {
  await prisma.$transaction((tx) => registrar(tx, e));
}

export interface ResultadoContinuidad {
  ok: boolean;
  registros: number;
  hallazgos: Array<{ seq: string; problema: string }>;
}

/** Recorre toda la cadena. Cualquier registro alterado, insertado o faltante es un hallazgo crítico. */
export async function verificarContinuidad(): Promise<ResultadoContinuidad> {
  const hallazgos: ResultadoContinuidad["hallazgos"] = [];
  let anterior = GENESIS;
  let total = 0;
  let cursor: bigint | undefined;
  for (;;) {
    const lote = await prisma.registroBitacora.findMany({
      orderBy: { seq: "asc" },
      take: 500,
      ...(cursor !== undefined ? { where: { seq: { gt: cursor } } } : {}),
    });
    if (lote.length === 0) break;
    for (const r of lote) {
      total++;
      if (r.hashAnterior !== anterior) hallazgos.push({ seq: String(r.seq), problema: "El registro no enlaza con el anterior (falta o se alteró un registro)" });
      const esperado = calcularHash(r.hashAnterior, {
        instante: r.instante.toISOString(),
        actorTipo: r.actorTipo,
        usuarioId: r.usuarioId,
        usuarioLogin: r.usuarioLogin,
        modulo: r.modulo,
        evento: r.evento,
        entidad: r.entidad,
        entidadId: r.entidadId,
        detalle: r.detalle ?? null,
        origen: r.origen,
      });
      if (esperado !== r.hash) hallazgos.push({ seq: String(r.seq), problema: "El contenido del registro no coincide con su huella" });
      anterior = r.hash;
      cursor = r.seq;
    }
  }
  return { ok: hallazgos.length === 0, registros: total, hallazgos };
}

export interface FiltroBitacora {
  usuario?: string;
  desde?: Date;
  hasta?: Date;
  evento?: string;
  modulo?: string;
  excluirModulos?: string[];
  limite?: number;
}

export async function consultar(f: FiltroBitacora) {
  if (f.modulo && f.excluirModulos?.includes(f.modulo)) return [];
  const where: Prisma.RegistroBitacoraWhereInput = {};
  if (f.usuario) where.usuarioLogin = { contains: f.usuario, mode: "insensitive" };
  if (f.evento) where.evento = f.evento;
  if (f.modulo) where.modulo = f.modulo;
  else if (f.excluirModulos?.length) where.modulo = { notIn: f.excluirModulos };
  if (f.desde || f.hasta) where.instante = { ...(f.desde ? { gte: f.desde } : {}), ...(f.hasta ? { lte: f.hasta } : {}) };
  return prisma.registroBitacora.findMany({ where, orderBy: { seq: "desc" }, take: Math.min(f.limite ?? 200, 5000) });
}
