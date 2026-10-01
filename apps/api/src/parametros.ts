import type { ParametroVista } from "@colbasoft/shared";
import { prisma } from "./db.js";

/**
 * Parámetros de configuración (M-19, RF-PAR-001).
 * IMPORTANTE: el SPEC no fija valores numéricos ni rangos (se calibran con línea base, que este proyecto no tiene).
 * Los valores por defecto y los rangos de abajo son **valores de demostración provisionales**, pensados para los datos
 * ficticios y para rechazar valores sin sentido. No son metas del proyecto.
 */
export interface DefinicionParametro {
  clave: string;
  descripcion: string;
  unidad: string;
  porDefecto: number;
  minimo: number;
  maximo: number;
  entero?: boolean;
}

export const DEFINICIONES: DefinicionParametro[] = [
  { clave: "intentos_bloqueo", descripcion: "Intentos fallidos consecutivos que bloquean la cuenta", unidad: "intentos", porDefecto: 5, minimo: 1, maximo: 20, entero: true },
  { clave: "inactividad_sesion_minutos", descripcion: "Inactividad tras la cual se cierra la sesión", unidad: "minutos", porDefecto: 15, minimo: 1, maximo: 480, entero: true },
  { clave: "aviso_inactividad_segundos", descripcion: "Aviso previo al cierre por inactividad", unidad: "segundos", porDefecto: 60, minimo: 10, maximo: 600, entero: true },
  { clave: "umbral_ajuste", descripcion: "Umbral que separa el ajuste menor (Jefe) del mayor (Administrador)", unidad: "unidades", porDefecto: 50, minimo: 1, maximo: 1_000_000 },
  { clave: "tolerancia_conteo_pct", descripcion: "Tolerancia de diferencia de conteo antes del segundo conteo", unidad: "%", porDefecto: 2, minimo: 0, maximo: 100 },
  { clave: "tiempo_transito_max_horas", descripcion: "Tiempo máximo en tránsito antes de alertar", unidad: "horas", porDefecto: 24, minimo: 1, maximo: 720 },
  { clave: "plazo_reserva_horas", descripcion: "Plazo para ejecutar una salida autorizada antes de liberar su reserva", unidad: "horas", porDefecto: 48, minimo: 1, maximo: 720 },
  { clave: "politica_toma", descripcion: "Política de toma para una salida: 1 = primero en entrar, primero en salir por lote; 2 = ubicación de mayor cantidad", unidad: "opción", porDefecto: 1, minimo: 1, maximo: 2, entero: true },
  { clave: "plazo_novedad_horas", descripcion: "Plazo para resolver una novedad antes de escalarla al Jefe", unidad: "horas", porDefecto: 72, minimo: 1, maximo: 720 },
  { clave: "umbral_autorizacion_coordinador", descripcion: "Cantidad hasta la que el Coordinador autoriza una salida", unidad: "unidades", porDefecto: 100, minimo: 1, maximo: 1_000_000 },
  { clave: "umbral_critico_conteo_general_pct", descripcion: "Diferencia global crítica de un conteo general", unidad: "%", porDefecto: 5, minimo: 0, maximo: 100 },
  { clave: "dias_sin_movimiento", descripcion: "Días sin movimiento para considerar existencia estancada", unidad: "días", porDefecto: 90, minimo: 1, maximo: 3650, entero: true },
  { clave: "volumen_referencia_diario", descripcion: "Movimientos diarios de referencia estimados (denominador de la adopción, KPI-24)", unidad: "movimientos", porDefecto: 100, minimo: 1, maximo: 1_000_000, entero: true },
];

export const definicion = (clave: string): DefinicionParametro | undefined => DEFINICIONES.find((d) => d.clave === clave);

export async function valorParametro(clave: string): Promise<number> {
  const def = definicion(clave);
  if (!def) throw new Error(`Parámetro desconocido: ${clave}`);
  const fila = await prisma.parametro.findUnique({ where: { clave } });
  return fila?.valor ?? def.porDefecto;
}

export async function listarParametros(solo?: string[]): Promise<ParametroVista[]> {
  const filas = new Map((await prisma.parametro.findMany()).map((f) => [f.clave, f.valor]));
  return DEFINICIONES.filter((d) => !solo || solo.includes(d.clave)).map((d) => ({
    clave: d.clave,
    descripcion: d.descripcion,
    unidad: d.unidad,
    valor: filas.get(d.clave) ?? d.porDefecto,
    porDefecto: d.porDefecto,
    minimo: d.minimo,
    maximo: d.maximo,
    modificado: filas.has(d.clave),
  }));
}

/** RF-PAR-002: valida el rango admisible. Devuelve el mensaje de error o null. */
export function validarValor(def: DefinicionParametro, valor: number): string | null {
  if (!Number.isFinite(valor)) return "El valor debe ser un número.";
  if (def.entero && !Number.isInteger(valor)) return "El valor debe ser un número entero.";
  if (valor < def.minimo || valor > def.maximo) return `El valor debe estar entre ${def.minimo} y ${def.maximo} ${def.unidad}.`;
  return null;
}
