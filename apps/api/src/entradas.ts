import type { Prisma } from "@prisma/client";
import { TIPOS_PIEZA_POR_UNIDAD, type EstadoDocumentoEntrada, type PropuestaUbicacion, type ResultadoLinea, type TipoPieza, type UnidadMedida } from "@colbasoft/shared";
import { ocupacionEnUnidad, ubicacionesConReferencia } from "./inventario.js";

type Tx = Prisma.TransactionClient;

/** Las cantidades se comparan en milésimas: así 0,1 + 0,2 es 0,3. Tres decimales es una precisión provisional (HD-18). */
export const aMilesimas = (n: number) => Math.round(n * 1000);
export const numero = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));

/** RN-INT-007: toda cantidad se expresa en la unidad de su referencia. Rollos y unidades se cuentan enteros. */
export function errorDeCantidad(unidad: UnidadMedida, n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return "La cantidad debe ser mayor que cero.";
  if (n > 1_000_000) return "La cantidad es demasiado grande.";
  if (unidad === "UNIDADES" || unidad === "ROLLOS") return Number.isInteger(n) ? null : `Una referencia en ${unidad.toLowerCase()} se cuenta en números enteros.`;
  return Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6 ? null : "Use como máximo tres decimales.";
}

/** F-1: el tipo de pieza depende de la unidad de la referencia. */
export const tipoCompatible = (unidad: UnidadMedida, tipo: TipoPieza) => TIPOS_PIEZA_POR_UNIDAD[unidad].includes(tipo);

export const recepcionCerrada = (e: EstadoDocumentoEntrada) => e === "RECIBIDO_CONFORME" || e === "RECIBIDO_CON_NOVEDAD" || e === "CONFIRMADO";

/** RN-ENT-003: compara lo recibido con lo esperado en una línea. Un faltante solo es definitivo al cerrar la recepción. */
export function resultadoLinea(esperada: number, recibida: number, cerrada: boolean): ResultadoLinea {
  const e = aMilesimas(esperada);
  const r = aMilesimas(recibida);
  if (r > e) return "SOBRANTE";
  if (r === e) return "CONFORME";
  if (cerrada) return "FALTANTE";
  return r === 0 ? "SIN_RECIBIR" : "EN_CURSO";
}

/** Ubicación donde queda la existencia al confirmar una entrada: la primera ubicación activa de una zona de recepción (RN-EXI-007). */
export async function ubicacionDeRecepcion(tx: Tx, bodegaId: string) {
  return tx.ubicacion.findFirst({ where: { bodegaId, activa: true, zona: { tipo: "RECEPCION" } }, orderBy: [{ zona: { codigo: "asc" } }, { codigo: "asc" }], include: { zona: true, bodega: true } });
}

export interface ContextoPieza {
  /** Cantidad que se va a ubicar (la pieza no se divide, HD-29). */
  cantidad: number;
  referenciaId: string;
  categoriaId: string;
  unidad: UnidadMedida;
  bodegaId: string;
}

const LIBRE_ILIMITADA = Number.POSITIVE_INFINITY;

type UbicacionConZona = Prisma.UbicacionGetPayload<{ include: { zona: true; bodega: true } }>;

/**
 * Capacidad libre de una ubicación para esta mercancía. Sin capacidad definida es ilimitada (HU-BOD-002); si la capacidad está
 * en otra unidad no es comparable —no hay conversión (RN-INT-007) ni regla de ocupación mixta (HD-17)— y tampoco limita.
 */
async function capacidadLibre(tx: Tx, u: UbicacionConZona, unidad: UnidadMedida): Promise<number> {
  if (u.capacidad === null || u.unidadCapacidad === null || u.unidadCapacidad !== unidad) return LIBRE_ILIMITADA;
  return u.capacidad - (await ocupacionEnUnidad(u.id, unidad, tx));
}

/** RN-MOV-002 / RF-MOV-005: el destino debe estar activo y tener capacidad. Devuelve el motivo del rechazo, o null si sirve. */
export async function errorDeDestino(tx: Tx, destino: UbicacionConZona, ctx: ContextoPieza): Promise<string | null> {
  if (destino.bodegaId !== ctx.bodegaId) return "La ubicación pertenece a otra bodega.";
  if (!destino.activa) return "La ubicación está desactivada: no puede recibir mercancía.";
  // Cuarentena es para mercancía inmovilizada (RN-ENT-006); la mercancía conforme no se ubica ahí.
  if (destino.zona.tipo === "CUARENTENA") return "La mercancía conforme no se ubica en una zona de cuarentena.";
  // Candado por ubicación: dos ubicaciones simultáneas no pueden sumar más que la capacidad.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"capacidad|" + destino.id}))`;
  const libre = await capacidadLibre(tx, destino, ctx.unidad);
  if (aMilesimas(libre) < aMilesimas(ctx.cantidad)) {
    return `No hay capacidad disponible en ${destino.codigo}: libre ${Math.max(0, libre)} ${ctx.unidad.toLowerCase()}, la pieza trae ${ctx.cantidad}.`;
  }
  return null;
}

/**
 * RN-MOV-001 / H-19: regla fija del Núcleo, en este orden: zona por categoría, agrupación por referencia y mayor capacidad libre.
 * Si ninguna ubicación aplica, propone la zona de recepción. Es una propuesta: el Auxiliar la confirma o la desvía.
 */
export async function proponerUbicacion(tx: Tx, ctx: ContextoPieza): Promise<PropuestaUbicacion> {
  const zonas = await tx.zona.findMany({
    where: { bodegaId: ctx.bodegaId, tipo: "ALMACENAMIENTO", categoriaId: ctx.categoriaId },
    include: { ubicaciones: { where: { activa: true }, include: { zona: true, bodega: true } } },
  });
  const candidatas: Array<{ u: UbicacionConZona; libre: number }> = [];
  for (const u of zonas.flatMap((z) => z.ubicaciones)) {
    const libre = await capacidadLibre(tx, u, ctx.unidad);
    if (aMilesimas(libre) >= aMilesimas(ctx.cantidad)) candidatas.push({ u, libre });
  }

  const agrupadas = await ubicacionesConReferencia(candidatas.map((c) => c.u.id), ctx.referenciaId, tx);
  const agrupables = candidatas.filter((c) => agrupadas.has(c.u.id));
  const porAgrupacion = agrupables.length > 0;
  const entre = porAgrupacion ? agrupables : candidatas;
  entre.sort((a, b) => (a.libre === b.libre ? a.u.codigo.localeCompare(b.u.codigo) : b.libre > a.libre ? 1 : -1));

  const elegida = entre[0];
  if (elegida) {
    const u = elegida.u;
    return {
      ubicacion: { id: u.id, codigo: u.codigo, zona: u.zona.codigo, bodega: u.bodega.codigo },
      criterio: porAgrupacion ? "AGRUPACION_POR_REFERENCIA" : "ZONA_POR_CATEGORIA",
      explicacion: porAgrupacion
        ? `Zona ${u.zona.codigo} (la de su categoría); ya guarda esta referencia y tiene capacidad.`
        : `Zona ${u.zona.codigo} (la de su categoría); es la ubicación con más capacidad libre.`,
    };
  }
  const rec = await ubicacionDeRecepcion(tx, ctx.bodegaId);
  if (!rec) throw new Error("La bodega no tiene una ubicación de recepción activa.");
  return {
    ubicacion: { id: rec.id, codigo: rec.codigo, zona: rec.zona.codigo, bodega: rec.bodega.codigo },
    criterio: "RECEPCION",
    explicacion: "Ninguna zona de su categoría tiene una ubicación con capacidad: se propone la zona de recepción.",
  };
}
