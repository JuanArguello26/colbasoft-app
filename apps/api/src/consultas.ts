import { ESTADOS_DESGLOSE, type DesgloseEstados, type EstadoDesglose, type ExistenciaReferencia, type KardexVista, type LineaKardex, type SkuVista, type TipoMovimientoVista, type UbicacionDeReferencia, type UnidadMedida } from "@colbasoft/shared";
import { prisma } from "./db.js";

/**
 * Consultas de existencia y de kardex (M-13, M-14). Todo sale de sumar los asientos del kardex (RN-INT-004, RF-INV-003);
 * nada se guarda aparte y leer nunca escribe (RN-INT-006, RF-INV-008).
 */

/** Asiento → pieza → línea → SKU, lote, ubicación y zona: lo que toda consulta necesita para describir una cantidad. */
const DESDE = `FROM "AsientoKardex" a
  JOIN "Pieza" p ON p.id = a."piezaId"
  JOIN "LineaEntrada" l ON l.id = p."lineaId"
  JOIN "Lote" lo ON lo.id = l."loteId"
  JOIN "Sku" s ON s.id = l."skuId"
  JOIN "Referencia" r ON r.id = s."referenciaId"
  JOIN "Talla" t ON t.id = s."tallaId"
  JOIN "Color" c ON c.id = s."colorId"
  JOIN "Ubicacion" u ON u.id = a."ubicacionId"
  JOIN "Zona" z ON z.id = u."zonaId"`;

const sinExistencia = (): DesgloseEstados => Object.fromEntries(ESTADOS_DESGLOSE.map((e) => [e, 0])) as DesgloseEstados;
const sumar = (d: DesgloseEstados, estado: string, cantidad: number) => { d[estado as EstadoDesglose] = (d[estado as EstadoDesglose] ?? 0) + cantidad; };
const total = (d: DesgloseEstados) => ESTADOS_DESGLOSE.reduce((s, e) => s + d[e], 0);

/** Parámetros posicionales sin riesgo de inyección: cada filtro entra como valor, nunca como texto de la consulta. */
class Condiciones {
  readonly valores: unknown[] = [];
  readonly partes: string[] = [];
  agregar(sql: (marcador: string) => string, valor: unknown) {
    this.valores.push(valor);
    this.partes.push(sql(`$${this.valores.length}`));
  }
  get donde() { return this.partes.length ? `WHERE ${this.partes.join(" AND ")}` : ""; }
}

export interface FiltroExistencia {
  /** Texto libre sobre el código o la descripción de la referencia. */
  q?: string | undefined;
  referenciaId?: string | undefined;
  skuId?: string | undefined;
  loteId?: string | undefined;
  ubicacionId?: string | undefined;
}

const MAX_REFERENCIAS = 50;

/** HU-INV-001 / RF-INV-001: cuánto hay de una referencia, por talla, color y lote, con el desglose por estado. */
export async function consultarExistencia(f: FiltroExistencia): Promise<ExistenciaReferencia[]> {
  // 1) Qué referencias se consultan: las que coinciden con el texto o el id, o las que tienen existencia bajo el resto de los filtros.
  const refs = new Condiciones();
  if (f.referenciaId) refs.agregar((m) => `r.id = ${m}`, f.referenciaId);
  if (f.q?.trim()) refs.agregar((m) => `(r.codigo ILIKE ${m} OR r.descripcion ILIKE ${m})`, `%${f.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
  const buscaPorExistencia = !f.referenciaId && !f.q?.trim();
  let candidatas: Array<{ id: string; codigo: string; descripcion: string; unidadMedida: UnidadMedida }>;
  if (buscaPorExistencia) {
    if (!f.skuId && !f.loteId && !f.ubicacionId) return [];
    const c = new Condiciones();
    if (f.skuId) c.agregar((m) => `s.id = ${m}`, f.skuId);
    if (f.loteId) c.agregar((m) => `lo.id = ${m}`, f.loteId);
    if (f.ubicacionId) c.agregar((m) => `a."ubicacionId" = ${m}`, f.ubicacionId);
    candidatas = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.codigo, r.descripcion, r."unidadMedida"::text AS "unidadMedida" ${DESDE} ${c.donde}
       GROUP BY r.id, r.codigo, r.descripcion, r."unidadMedida", a."piezaId", a."ubicacionId", a.estado HAVING SUM(a.delta) > 0
       ORDER BY r.codigo LIMIT ${MAX_REFERENCIAS}`, ...c.valores);
    const unicas = new Map(candidatas.map((x) => [x.id, x]));
    candidatas = [...unicas.values()];
  } else {
    candidatas = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.codigo, r.descripcion, r."unidadMedida"::text AS "unidadMedida" FROM "Referencia" r ${refs.donde} ORDER BY r.codigo LIMIT ${MAX_REFERENCIAS}`, ...refs.valores);
  }
  if (candidatas.length === 0) return [];

  // 2) Su existencia, agrupada por SKU, lote y estado.
  const c = new Condiciones();
  c.agregar((m) => `r.id = ANY(${m}::text[])`, candidatas.map((x) => x.id));
  if (f.skuId) c.agregar((m) => `s.id = ${m}`, f.skuId);
  if (f.loteId) c.agregar((m) => `lo.id = ${m}`, f.loteId);
  if (f.ubicacionId) c.agregar((m) => `a."ubicacionId" = ${m}`, f.ubicacionId);
  const filas = await prisma.$queryRawUnsafe<Array<FilaSku & { loteId: string; lote: string; estado: string; cantidad: number }>>(
    `SELECT r.id AS "referenciaId", r.codigo, r.descripcion, r."unidadMedida"::text AS "unidadMedida", s.id AS "skuId", t.nombre AS talla, c.nombre AS color,
            lo.id AS "loteId", lo.codigo AS lote, a.estado::text AS estado, SUM(a.delta)::float8 AS cantidad
     ${DESDE} ${c.donde}
     GROUP BY r.id, r.codigo, r.descripcion, r."unidadMedida", s.id, t.nombre, c.nombre, lo.id, lo.codigo, a.estado
     HAVING SUM(a.delta) > 0 ORDER BY r.codigo, t.nombre, c.nombre, lo.codigo`, ...c.valores);

  const salida = new Map<string, ExistenciaReferencia>(candidatas.map((x) => [x.id, { referenciaId: x.id, codigo: x.codigo, descripcion: x.descripcion, unidadMedida: x.unidadMedida, porEstado: sinExistencia(), total: 0, detalle: [] }]));
  const detalles = new Map<string, ExistenciaReferencia["detalle"][number]>();
  for (const x of filas) {
    const ref = salida.get(x.referenciaId)!;
    const clave = `${x.skuId}|${x.loteId}`;
    let d = detalles.get(clave);
    if (!d) {
      d = { sku: skuDe(x), lote: { id: x.loteId, codigo: x.lote }, porEstado: sinExistencia(), total: 0 };
      detalles.set(clave, d);
      ref.detalle.push(d);
    }
    sumar(d.porEstado, x.estado, x.cantidad);
    sumar(ref.porEstado, x.estado, x.cantidad);
  }
  for (const d of detalles.values()) d.total = total(d.porEstado);
  for (const ref of salida.values()) ref.total = total(ref.porEstado);
  return [...salida.values()];
}

interface FilaSku { referenciaId: string; codigo: string; descripcion: string; unidadMedida: UnidadMedida; skuId: string; talla: string; color: string }
const skuDe = (x: FilaSku): SkuVista => ({ id: x.skuId, referencia: x.codigo, descripcion: x.descripcion, talla: x.talla, color: x.color, unidadMedida: x.unidadMedida });

export interface FiltroDondeEsta {
  referenciaId: string;
  talla?: string | undefined;
  color?: string | undefined;
  /** Código del lote. */
  lote?: string | undefined;
  orden: "cantidad" | "zona";
}

/** HU-INV-003 / RF-INV-004: todas las ubicaciones con existencia de la referencia y su cantidad; marca lo que no está disponible. */
export async function dondeEsta(f: FiltroDondeEsta): Promise<UbicacionDeReferencia[]> {
  const c = new Condiciones();
  c.agregar((m) => `r.id = ${m}`, f.referenciaId);
  if (f.talla) c.agregar((m) => `t.nombre = ${m}`, f.talla);
  if (f.color) c.agregar((m) => `c.nombre = ${m}`, f.color);
  if (f.lote) c.agregar((m) => `lo.codigo = ${m}`, f.lote.toUpperCase());
  const filas = await prisma.$queryRawUnsafe<Array<FilaSku & { ubicacionId: string; ubicacion: string; zona: string; loteId: string; lote: string; estado: EstadoDesglose; cantidad: number }>>(
    `SELECT r.id AS "referenciaId", r.codigo, r.descripcion, r."unidadMedida"::text AS "unidadMedida", s.id AS "skuId", t.nombre AS talla, c.nombre AS color,
            lo.id AS "loteId", lo.codigo AS lote, a."ubicacionId", u.codigo AS ubicacion, z.codigo AS zona, a.estado::text AS estado, SUM(a.delta)::float8 AS cantidad
     ${DESDE} ${c.donde}
     GROUP BY r.id, r.codigo, r.descripcion, r."unidadMedida", s.id, t.nombre, c.nombre, lo.id, lo.codigo, a."ubicacionId", u.codigo, z.codigo, a.estado
     HAVING SUM(a.delta) > 0`, ...c.valores);
  const lista = filas.map((x): UbicacionDeReferencia => ({
    ubicacionId: x.ubicacionId, ubicacion: x.ubicacion, zona: x.zona, sku: skuDe(x), lote: { id: x.loteId, codigo: x.lote },
    estado: x.estado, cantidad: x.cantidad, disponible: x.estado === "DISPONIBLE",
  }));
  const porUbicacion = (a: UbicacionDeReferencia, b: UbicacionDeReferencia) => a.ubicacion.localeCompare(b.ubicacion) || a.sku.talla.localeCompare(b.sku.talla) || a.sku.color.localeCompare(b.sku.color) || a.lote.codigo.localeCompare(b.lote.codigo) || a.estado.localeCompare(b.estado);
  return lista.sort(f.orden === "cantidad"
    ? (a, b) => b.cantidad - a.cantidad || porUbicacion(a, b)
    : (a, b) => a.zona.localeCompare(b.zona) || porUbicacion(a, b));
}

export interface FiltroKardex {
  piezaId?: string | undefined;
  skuId?: string | undefined;
  loteId?: string | undefined;
  ubicacionId?: string | undefined;
  /** Restricción del Auxiliar: solo lo que él movió y desde esta fecha. */
  soloUsuarioId?: string | undefined;
  desde?: Date | undefined;
  limite?: number | undefined;
}

/**
 * HU-KDX-001 y HU-KDX-006: los movimientos de una unidad de inventario (SKU + lote + ubicación) o de una pieza, en orden cronológico.
 * La «existencia resultante» es la suma acumulada de las cantidades dentro de lo consultado; se calcula antes de aplicar las
 * restricciones del Auxiliar para que su cifra siga siendo la verdadera. Dentro de un movimiento, lo que resta va antes de lo que suma
 * (el origen antes que el destino).
 */
export async function consultarKardex(f: FiltroKardex): Promise<KardexVista> {
  const limite = f.limite ?? 2000;
  const c = new Condiciones();
  if (f.piezaId) c.agregar((m) => `a."piezaId" = ${m}`, f.piezaId);
  if (f.skuId) c.agregar((m) => `s.id = ${m}`, f.skuId);
  if (f.loteId) c.agregar((m) => `lo.id = ${m}`, f.loteId);
  if (f.ubicacionId) c.agregar((m) => `a."ubicacionId" = ${m}`, f.ubicacionId);
  const fuera = new Condiciones();
  fuera.valores.push(...c.valores);
  if (f.soloUsuarioId) fuera.agregar((m) => `x."usuarioId" = ${m}`, f.soloUsuarioId);
  if (f.desde) fuera.agregar((m) => `x."confirmadoEn" >= ${m}`, f.desde);
  const filas = await prisma.$queryRawUnsafe<Array<FilaSku & {
    movimientoId: string; secuencia: number; confirmadoEn: Date; tipo: TipoMovimientoVista; delta: number; existencia: number; estado: EstadoDesglose;
    ubicacion: string; pieza: number; lote: string; usuarioLogin: string; documento: number | null; motivo: string | null; anulaA: number | null; anuladoPor: number | null;
  }>>(
    `SELECT * FROM (
       SELECT m.id AS "movimientoId", m.secuencia, m."confirmadoEn", m.tipo::text AS tipo, m."usuarioId", m."usuarioLogin", de.numero AS documento, mo.nombre AS motivo,
              ma.secuencia AS "anulaA", mx.secuencia AS "anuladoPor", a.id AS "asientoId", a.delta::float8 AS delta, a.estado::text AS estado, p.numero AS pieza,
              r.id AS "referenciaId", r.codigo, r.descripcion, r."unidadMedida"::text AS "unidadMedida", s.id AS "skuId", t.nombre AS talla, c.nombre AS color,
              lo.codigo AS lote, u.codigo AS ubicacion,
              SUM(a.delta) OVER (ORDER BY m.secuencia, a.delta, a.id)::float8 AS existencia
       ${DESDE}
       JOIN "Movimiento" m ON m.id = a."movimientoId"
       LEFT JOIN "DocumentoEntrada" de ON de.id = m."documentoEntradaId"
       LEFT JOIN "Motivo" mo ON mo.id = m."motivoId"
       LEFT JOIN "Movimiento" ma ON ma.id = m."anulaAId"
       LEFT JOIN "Movimiento" mx ON mx."anulaAId" = m.id
       ${c.donde}
     ) x ${fuera.partes.length ? `WHERE ${fuera.partes.join(" AND ")}` : ""}
     ORDER BY x.secuencia, x.delta, x."asientoId" LIMIT ${limite + 1}`, ...fuera.valores);
  const truncado = filas.length > limite;
  const usadas = truncado ? filas.slice(0, limite) : filas;
  let previo = 0;
  let continuo = true;
  const lineas = usadas.map((x): LineaKardex => {
    // Cada línea debe ser la anterior más su cantidad (con la tolerancia del punto flotante); si hubo restricción del Auxiliar
    // no se compara contra la línea anterior visible, sino contra su propio acumulado.
    const esperado = previo + x.delta;
    if (!f.soloUsuarioId && !f.desde && (Math.abs(esperado - x.existencia) > 1e-6 || x.existencia < -1e-6)) continuo = false;
    previo = x.existencia;
    return {
      movimientoId: x.movimientoId, secuencia: x.secuencia, instante: x.confirmadoEn.toISOString(), tipo: x.tipo, cantidad: x.delta, existenciaResultante: x.existencia,
      estado: x.estado, ubicacion: x.ubicacion, pieza: x.pieza, sku: skuDe(x), lote: x.lote, usuario: x.usuarioLogin, documento: x.documento, motivo: x.motivo, anulaA: x.anulaA, anuladoPor: x.anuladoPor,
    };
  });
  return { lineas, existenciaFinal: previo, continuidad: { ok: continuo, lineas: lineas.length }, truncado, restringido: Boolean(f.soloUsuarioId || f.desde) };
}
