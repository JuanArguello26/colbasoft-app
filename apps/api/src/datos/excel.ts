/** Estructura de la hoja de datos ficticios (DS-1). El Excel solo alimenta la carga: NO es la base de datos. */
export const HOJAS = {
  usuarios: ["login", "nombre", "rol", "clave_inicial"],
  categorias: ["nombre"],
  referencias: ["codigo", "descripcion", "categoria", "unidad_medida", "tallas", "colores"],
  bodegas: ["codigo", "nombre"],
  zonas: ["bodega", "codigo", "nombre", "tipo"],
  ubicaciones: ["bodega", "zona", "codigo"],
} as const;

export type NombreHoja = keyof typeof HOJAS;
