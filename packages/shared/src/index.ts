/** Los cinco roles oficiales (SPEC DC-04). «Sistema» es un actor, no un rol. */
export const ROLES = ["ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA", "AUXILIAR_BODEGA", "AUDITOR"] as const;
export type Rol = (typeof ROLES)[number];

export const ROL_NOMBRE: Record<Rol, string> = {
  ADMINISTRADOR: "Administrador",
  JEFE_BODEGA: "Jefe de Bodega",
  COORDINADOR_BODEGA: "Coordinador de Bodega",
  AUXILIAR_BODEGA: "Auxiliar de Bodega",
  AUDITOR: "Auditor",
};

/** Unidades de medida admitidas (CD-11): fijas por referencia. */
export const UNIDADES_MEDIDA = ["UNIDADES", "METROS", "ROLLOS", "KILOGRAMOS"] as const;
export type UnidadMedida = (typeof UNIDADES_MEDIDA)[number];

export interface UsuarioSesion {
  id: string;
  login: string;
  nombre: string;
  rol: Rol;
}

export interface ReferenciaResumen {
  id: string;
  codigo: string;
  descripcion: string;
  categoria: string;
  unidadMedida: UnidadMedida;
  activa: boolean;
  skus: number;
}
