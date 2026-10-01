import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { Prisma } from "@prisma/client";
import type { EtiquetaVista, IdentificadorTipo } from "@colbasoft/shared";
import { prisma } from "./db.js";

/**
 * Identificadores QR (M-06, RN-IDE-001/002).
 * - El valor del QR es opaco y aleatorio: no codifica ubicación, cantidad ni nada que pueda cambiar (DF5-01).
 * - El prefijo distingue mercancía (COL-M-) de ubicación (COL-U-) sin consultar la base (HU-QRC-003 criterio 4).
 * - Ningún valor se repite jamás: la restricción única y los disparadores de la base impiden reutilizar o borrar uno emitido.
 */
export const PREFIJO: Record<IdentificadorTipo, string> = { MERCANCIA: "COL-M-", UBICACION: "COL-U-" };

// El respaldo se digita a mano: se quitan los pares que se confunden al leerlos (0/O, 1/I/L, 8/B, 5/S, 2/Z). 25 símbolos.
const ALFABETO = "ACDEFGHJKMNPQRTUVWXY34679";
const LIMITE = 250; // 25 * 10: se descartan los bytes mayores para que cada símbolo sea igual de probable

function generarValor(tipo: IdentificadorTipo): string {
  let letras = "";
  while (letras.length < 10) for (const b of randomBytes(16)) if (b < LIMITE && letras.length < 10) letras += ALFABETO[b % 25];
  return `${PREFIJO[tipo]}${letras.slice(0, 5)}-${letras.slice(5)}`;
}

type Cliente = Prisma.TransactionClient;

async function valorLibre(tx: Cliente, tipo: IdentificadorTipo): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const valor = generarValor(tipo);
    if (!(await tx.identificador.findUnique({ where: { codigo: valor } }))) return valor;
  }
  throw new Error("No se pudo generar un identificador libre.");
}

export async function crearIdentificadorMercancia(tx: Cliente, loteId: string) {
  return tx.identificador.create({ data: { codigo: await valorLibre(tx, "MERCANCIA"), tipo: "MERCANCIA", loteId } });
}

/** Devuelve el identificador de la ubicación; si no tiene, lo crea. `nuevo` indica si se creó ahora. */
export async function asegurarIdentificadorUbicacion(tx: Cliente, ubicacionId: string) {
  const existente = await tx.identificador.findUnique({ where: { ubicacionId } });
  if (existente) return { identificador: existente, nuevo: false };
  const identificador = await tx.identificador.create({ data: { codigo: await valorLibre(tx, "UBICACION"), tipo: "UBICACION", ubicacionId } });
  return { identificador, nuevo: true };
}

const qrComoSvg = (valor: string) => QRCode.toString(valor, { type: "svg", errorCorrectionLevel: "M", margin: 1 });

/** HU-QRC-001 criterio 3 / RF-QRC-005: el QR más la información legible de respaldo. */
export async function etiquetasDe(ids: string[]): Promise<EtiquetaVista[]> {
  const filas = await prisma.identificador.findMany({
    where: { id: { in: ids } },
    include: {
      lote: { include: { sku: { include: { referencia: true, talla: true, color: true } } } },
      ubicacion: { include: { zona: true, bodega: true } },
    },
  });
  const porId = new Map(filas.map((f) => [f.id, f]));
  const etiquetas: EtiquetaVista[] = [];
  for (const id of ids) {
    const f = porId.get(id);
    if (!f) continue;
    const base = { id: f.id, codigo: f.codigo, tipo: f.tipo, estado: f.estado, svg: await qrComoSvg(f.codigo) };
    if (f.lote) {
      const s = f.lote.sku;
      etiquetas.push({ ...base, mercancia: { referencia: s.referencia.codigo, descripcion: s.referencia.descripcion, talla: s.talla.nombre, color: s.color.nombre, lote: f.lote.codigo } });
    } else if (f.ubicacion) {
      etiquetas.push({ ...base, ubicacion: { bodega: f.ubicacion.bodega.codigo, zona: f.ubicacion.zona.codigo, codigo: f.ubicacion.codigo } });
    }
  }
  return etiquetas;
}
