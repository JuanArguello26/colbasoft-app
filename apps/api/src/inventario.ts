import type { ExistenciaEnUbicacion } from "@colbasoft/shared";

/**
 * Consultas al inventario que otras reglas necesitan. Hoy NO existen movimientos ni existencia (bloques C1-3 a C1-6),
 * así que estas funciones devuelven `false`. Cuando existan las tablas, se reemplazan por consultas reales y se
 * activan las pruebas marcadas como `todo` (RN-004, RN-013, desactivar referencia con existencia).
 */
export async function referenciaTieneMovimientos(_referenciaId: string): Promise<boolean> {
  return false;
}

export async function referenciaTieneExistencia(_referenciaId: string): Promise<boolean> {
  return false;
}

export async function ubicacionTieneExistencia(_ubicacionId: string): Promise<boolean> {
  return false;
}

/** HU-QRC-002 criterio 2: ubicaciones donde un SKU + Lote tiene existencia. Sin movimientos (C1-3) no hay ninguna. */
export async function ubicacionesConExistencia(_skuId: string, _loteId: string): Promise<ExistenciaEnUbicacion[]> {
  return [];
}
