import type { Prisma } from "@prisma/client";
import type { EstadoExistencia, ExistenciaEnUbicacion, UnidadMedida } from "@colbasoft/shared";
import { prisma } from "./db.js";

/**
 * Consultas al inventario. La existencia NO se guarda: es siempre la suma de los asientos del kardex (RN-INT-004),
 * agrupada por pieza, ubicación y estado. Leer nunca escribe (RN-INT-006).
 */
type Cliente = Prisma.TransactionClient | typeof prisma;

/** Asientos con su pieza, SKU y lote, listos para agrupar. */
const DESDE = `FROM "AsientoKardex" a
  JOIN "Pieza" p ON p.id = a."piezaId"
  JOIN "LineaEntrada" l ON l.id = p."lineaId"
  JOIN "Sku" s ON s.id = l."skuId"
  JOIN "Referencia" r ON r.id = s."referenciaId"
  JOIN "Ubicacion" u ON u.id = a."ubicacionId"`;

/** RN-004: una referencia con movimientos no cambia de unidad de medida. */
export async function referenciaTieneMovimientos(referenciaId: string): Promise<boolean> {
  return (await prisma.asientoKardex.findFirst({ where: { pieza: { linea: { sku: { referenciaId } } } }, select: { id: true } })) !== null;
}

/** RN-MAE-003: una referencia con existencia no se desactiva. */
export async function referenciaTieneExistencia(referenciaId: string): Promise<boolean> {
  const f = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 ${DESDE} WHERE r.id = $1 GROUP BY a."piezaId", a."ubicacionId", a.estado HAVING SUM(a.delta) > 0 LIMIT 1`, referenciaId);
  return f.length > 0;
}

/** Una ubicación con existencia no se desactiva. */
export async function ubicacionTieneExistencia(ubicacionId: string): Promise<boolean> {
  const f = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM "AsientoKardex" a WHERE a."ubicacionId" = $1 GROUP BY a."piezaId", a.estado HAVING SUM(a.delta) > 0 LIMIT 1`, ubicacionId);
  return f.length > 0;
}

/** HU-QRC-002 criterio 2: ubicaciones donde un SKU + Lote tiene existencia, con su estado. */
export async function ubicacionesConExistencia(skuId: string, loteId: string): Promise<ExistenciaEnUbicacion[]> {
  const f = await prisma.$queryRawUnsafe<Array<{ ubicacionId: string; ubicacion: string; estado: EstadoExistencia; cantidad: number }>>(
    `SELECT a."ubicacionId", u.codigo AS ubicacion, a.estado::text AS estado, SUM(a.delta)::float8 AS cantidad
     ${DESDE} WHERE s.id = $1 AND l."loteId" = $2
     GROUP BY a."ubicacionId", u.codigo, a.estado HAVING SUM(a.delta) > 0 ORDER BY u.codigo, a.estado`, skuId, loteId);
  return f;
}

/** Dónde está cada pieza hoy y cuánto le queda ahí (RN-LOT-007). Solo lo que tiene cantidad positiva. */
export async function existenciaDePiezas(piezaIds: string[], cliente: Cliente = prisma): Promise<Map<string, ExistenciaEnUbicacion[]>> {
  const salida = new Map<string, ExistenciaEnUbicacion[]>();
  if (piezaIds.length === 0) return salida;
  const f = await cliente.$queryRawUnsafe<Array<{ piezaId: string; ubicacionId: string; ubicacion: string; estado: EstadoExistencia; cantidad: number }>>(
    `SELECT a."piezaId", a."ubicacionId", u.codigo AS ubicacion, a.estado::text AS estado, SUM(a.delta)::float8 AS cantidad
     FROM "AsientoKardex" a JOIN "Ubicacion" u ON u.id = a."ubicacionId"
     WHERE a."piezaId" = ANY($1::text[]) GROUP BY a."piezaId", a."ubicacionId", u.codigo, a.estado HAVING SUM(a.delta) > 0`, piezaIds);
  for (const x of f) {
    const lista = salida.get(x.piezaId) ?? [];
    lista.push({ ubicacionId: x.ubicacionId, ubicacion: x.ubicacion, estado: x.estado, cantidad: x.cantidad });
    salida.set(x.piezaId, lista);
  }
  return salida;
}

/**
 * Lo que ocupa hoy una ubicación, contando solo la mercancía medida en `unidad`: la capacidad se expresa en una sola unidad
 * y el sistema no convierte entre unidades (RN-INT-007). La ocupación mixta queda abierta (HD-17).
 */
export async function ocupacionEnUnidad(ubicacionId: string, unidad: UnidadMedida, cliente: Cliente = prisma): Promise<number> {
  const f = await cliente.$queryRawUnsafe<Array<{ total: number | null }>>(
    `SELECT SUM(a.delta)::float8 AS total ${DESDE} WHERE a."ubicacionId" = $1 AND r."unidadMedida"::text = $2`, ubicacionId, unidad);
  return f[0]?.total ?? 0;
}

/** Ubicaciones (entre las dadas) que ya guardan existencia de la referencia: criterio de agrupación por referencia. */
export async function ubicacionesConReferencia(ubicacionIds: string[], referenciaId: string, cliente: Cliente = prisma): Promise<Set<string>> {
  if (ubicacionIds.length === 0) return new Set();
  const f = await cliente.$queryRawUnsafe<Array<{ ubicacionId: string }>>(
    `SELECT a."ubicacionId" ${DESDE} WHERE r.id = $1 AND a."ubicacionId" = ANY($2::text[])
     GROUP BY a."ubicacionId", a."piezaId", a.estado HAVING SUM(a.delta) > 0`, referenciaId, ubicacionIds);
  return new Set(f.map((x) => x.ubicacionId));
}
