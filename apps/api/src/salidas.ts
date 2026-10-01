import type { Prisma } from "@prisma/client";
import type { LineaSalidaVista, ReservaVista, SalidaVista } from "@colbasoft/shared";
import { prisma } from "./db.js";
import { registrar } from "./bitacora.js";
import { aMilesimas, numero } from "./entradas.js";
import { valorParametro } from "./parametros.js";

/**
 * Salidas (M-08). La existencia reservada vive en el kardex (estado RESERVADO): reservar mueve la cantidad de disponible a reservada,
 * sacar la descuenta de reservada y liberar la devuelve a disponible. Nada se guarda aparte (RN-INT-004). Las tablas de salida solo
 * recuerdan el plan: qué parte de qué pieza se reservó para cada línea y qué se tomó al preparar.
 */
type Tx = Prisma.TransactionClient;
type Cliente = Tx | typeof prisma;

export interface PiezaDisponible {
  piezaId: string;
  numero: number;
  ubicacionId: string;
  ubicacion: string;
  loteId: string;
  loteCodigo: string;
  fechaIngreso: Date;
  cantidad: number;
}

/** Existencia DISPONIBLE (no reservada, no en recepción) de un SKU, opcionalmente de un lote, por pieza y ubicación, en una bodega. */
export async function disponiblesDe(c: Cliente, bodegaId: string, skuId: string, loteId?: string | null): Promise<PiezaDisponible[]> {
  const filas = await c.$queryRawUnsafe<PiezaDisponible[]>(
    `SELECT a."piezaId", p.numero, a."ubicacionId", u.codigo AS ubicacion, lo.id AS "loteId", lo.codigo AS "loteCodigo", lo."fechaIngreso", SUM(a.delta)::float8 AS cantidad
     FROM "AsientoKardex" a
     JOIN "Pieza" p ON p.id = a."piezaId"
     JOIN "LineaEntrada" l ON l.id = p."lineaId"
     JOIN "Lote" lo ON lo.id = l."loteId"
     JOIN "Ubicacion" u ON u.id = a."ubicacionId"
     WHERE a.estado = 'DISPONIBLE' AND u."bodegaId" = $1 AND l."skuId" = $2 ${loteId ? 'AND lo.id = $3' : ""}
     GROUP BY a."piezaId", p.numero, a."ubicacionId", u.codigo, lo.id, lo.codigo, lo."fechaIngreso"
     HAVING SUM(a.delta) > 0`, ...(loteId ? [bodegaId, skuId, loteId] : [bodegaId, skuId]));
  return filas;
}

export const totalDe = (piezas: PiezaDisponible[]) => piezas.reduce((s, p) => s + p.cantidad, 0);

export interface Asignacion { piezaId: string; ubicacionId: string; cantidad: number }

/**
 * RN-SAL-003: la toma sigue la política configurada. 1 = primero en entrar, primero en salir por lote; 2 = ubicación de mayor cantidad.
 * («Ubicación más próxima» no existe: el sistema no modela distancias.) El sistema propone; el operario ejecuta.
 * Devuelve lo asignado y lo que falta por cubrir (0 si alcanza).
 */
export async function asignar(piezas: PiezaDisponible[], cantidad: number): Promise<{ asignado: Asignacion[]; falta: number }> {
  const politica = await valorParametro("politica_toma");
  const orden = [...piezas].sort(politica === 2
    ? (a, b) => b.cantidad - a.cantidad || a.numero - b.numero
    : (a, b) => a.fechaIngreso.getTime() - b.fechaIngreso.getTime() || a.numero - b.numero);
  let falta = aMilesimas(cantidad);
  const asignado: Asignacion[] = [];
  for (const p of orden) {
    if (falta <= 0) break;
    const toma = Math.min(falta, aMilesimas(p.cantidad));
    asignado.push({ piezaId: p.piezaId, ubicacionId: p.ubicacionId, cantidad: toma / 1000 });
    falta -= toma;
  }
  return { asignado, falta: falta / 1000 };
}

/** Candado de fila: las transiciones de una salida se serializan (autorizar, confirmar, cancelar y vencer no se pisan). */
export async function bloquear(tx: Tx, salidaId: string) {
  await tx.$queryRaw`SELECT id FROM "Salida" WHERE id = ${salidaId} FOR UPDATE`;
}

/** Devuelve a disponible lo reservado y no sacado. Un solo movimiento de liberación con un par de asientos por reserva. */
export async function liberar(tx: Tx, salidaId: string, usuario: { id: string; login: string }, partes: Array<{ piezaId: string; ubicacionId: string; cantidad: number }>) {
  const pendientes = partes.filter((p) => aMilesimas(p.cantidad) > 0);
  if (pendientes.length === 0) return null;
  const ahora = new Date();
  return tx.movimiento.create({
    data: {
      tipo: "LIBERACION", salidaId, usuarioId: usuario.id, usuarioLogin: usuario.login, iniciadoEn: ahora, confirmadoEn: ahora,
      asientos: { create: pendientes.flatMap((p) => [
        { piezaId: p.piezaId, ubicacionId: p.ubicacionId, estado: "RESERVADO" as const, delta: -p.cantidad },
        { piezaId: p.piezaId, ubicacionId: p.ubicacionId, estado: "DISPONIBLE" as const, delta: p.cantidad },
      ]) },
    },
  });
}

/** Lo reservado de una salida y no tomado todavía (o lo reservado completo si se cancela o vence). */
async function reservasConToma(tx: Cliente, salidaId: string) {
  return tx.reservaSalida.findMany({ where: { linea: { salidaId } }, include: { toma: true } });
}

/**
 * RN-SAL-005 / RF-SAL-014: una reserva que no se ejecuta dentro del plazo se libera sola, la existencia vuelve a disponible y la salida
 * queda «vencida». La alerta al solicitante llega con el módulo de alertas (fuera del corte C1): hoy queda en la bitácora y a la vista.
 * Se llama al consultar y al operar, y por un temporizador del servidor.
 */
export async function liberarVencidas(): Promise<number> {
  const vencidas = await prisma.salida.findMany({ where: { estado: "AUTORIZADA", venceEn: { lt: new Date() } }, select: { id: true } });
  let liberadas = 0;
  for (const { id } of vencidas) {
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, id);
      const s = await tx.salida.findUnique({ where: { id } });
      if (!s || s.estado !== "AUTORIZADA" || !s.venceEn || s.venceEn.getTime() >= Date.now()) return;
      const reservas = await reservasConToma(tx, id);
      await liberar(tx, id, { id: s.solicitadaPorId, login: "sistema" }, reservas.map((r) => ({ piezaId: r.piezaId, ubicacionId: r.ubicacionId, cantidad: numero(r.cantidad) })));
      await tx.salida.update({ where: { id }, data: { estado: "VENCIDA" } });
      await registrar(tx, { actor: { tipo: "SISTEMA" }, modulo: "SALIDAS", evento: "reserva_liberada_por_vencimiento", entidad: "Salida", entidadId: id, detalle: { salida: s.numero, solicitadaPor: s.solicitadaPorLogin, venceEn: s.venceEn.toISOString() } });
      liberadas++;
    });
  }
  return liberadas;
}

/** La vista completa de una salida: líneas, lo reservado, lo tomado y si ya se puede confirmar. */
export async function vistaDeSalida(c: Cliente, salidaId: string): Promise<SalidaVista | null> {
  const s = await c.salida.findUnique({
    where: { id: salidaId },
    include: {
      motivo: true,
      lineas: { include: { sku: { include: { referencia: true, talla: true, color: true } }, lote: true, reservas: { include: { toma: true, pieza: { include: { linea: { include: { lote: true } } } }, ubicacion: true } } }, orderBy: { id: "asc" } },
    },
  });
  if (!s) return null;
  const reservas: ReservaVista[] = [];
  const detalle: LineaSalidaVista[] = [];
  // Lo que tiene cada pieza hoy en cada ubicación (reservado y disponible), para mostrar lo que le queda tras un corte.
  const piezaIds = [...new Set(s.lineas.flatMap((l) => l.reservas.map((r) => r.piezaId)))];
  const hoy = piezaIds.length === 0 ? [] : await c.$queryRawUnsafe<Array<{ piezaId: string; ubicacionId: string; total: number }>>(
    `SELECT "piezaId", "ubicacionId", SUM(delta)::float8 AS total FROM "AsientoKardex" WHERE "piezaId" = ANY($1::text[]) GROUP BY "piezaId", "ubicacionId"`, piezaIds);
  const totalHoy = (piezaId: string, ubicacionId: string) => hoy.find((h) => h.piezaId === piezaId && h.ubicacionId === ubicacionId)?.total ?? 0;
  for (const l of s.lineas) {
    let tomada = 0;
    let piezasTomadas = 0;
    for (const r of l.reservas) {
      const t = r.toma ? numero(r.toma.cantidad) : null;
      if (t !== null) { tomada += t; piezasTomadas++; }
      reservas.push({
        id: r.id, lineaId: l.id, piezaId: r.piezaId, pieza: r.pieza.numero, tipo: r.pieza.tipo, lote: r.pieza.linea.lote?.codigo ?? "", ubicacion: r.ubicacion.codigo,
        cantidad: numero(r.cantidad), piezaTotal: totalHoy(r.piezaId, r.ubicacionId), tomada: t,
      });
    }
    detalle.push({
      id: l.id,
      sku: { id: l.sku.id, referencia: l.sku.referencia.codigo, descripcion: l.sku.referencia.descripcion, talla: l.sku.talla.nombre, color: l.sku.color.nombre, unidadMedida: l.sku.referencia.unidadMedida },
      lote: l.lote ? { id: l.lote.id, codigo: l.lote.codigo } : null,
      cantidad: numero(l.cantidad), cantidadPedida: numero(l.cantidadPedida), tomada, piezasTomadas, piezasReservadas: l.reservas.length,
    });
  }
  const completa = s.estado === "AUTORIZADA" && detalle.length > 0 && detalle.every((l) => l.piezasReservadas > 0 && l.piezasTomadas === l.piezasReservadas && aMilesimas(l.tomada) === aMilesimas(l.cantidad));
  return {
    id: s.id, numero: s.numero, estado: s.estado, motivo: s.motivo.nombre, parcial: s.parcial, solicitadaPor: s.solicitadaPorLogin, solicitadaEn: s.solicitadaEn.toISOString(),
    lineas: s.lineas.length, cantidad: s.lineas.reduce((a, l) => a + numero(l.cantidad), 0),
    observacion: s.observacion, autorizadaPor: s.autorizadaPorLogin, autorizadaEn: s.autorizadaEn?.toISOString() ?? null, venceEn: s.venceEn?.toISOString() ?? null,
    confirmadaPor: s.confirmadaPorLogin, confirmadaEn: s.confirmadaEn?.toISOString() ?? null, canceladaPor: s.canceladaPorLogin,
    detalle, reservas, completa,
  };
}
