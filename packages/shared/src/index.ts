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

export const TIPOS_OPERACION = ["AJUSTE", "ANULACION", "SALIDA", "DESCARTE_ALERTA"] as const;
export type TipoOperacion = (typeof TIPOS_OPERACION)[number];

export const ZONA_TIPOS = ["RECEPCION", "ALMACENAMIENTO", "PREPARACION_SALIDA", "CUARENTENA"] as const;
export type ZonaTipo = (typeof ZONA_TIPOS)[number];

export interface SesionInfo extends UsuarioSesion {
  debeCambiarClave: boolean;
  /** Instante (ms desde epoch) en que la sesión se cierra por inactividad si no hay actividad. */
  expiraEn: number;
  /** Segundos de aviso antes del cierre por inactividad. */
  avisoSegundos: number;
}

export interface UsuarioAdmin extends UsuarioSesion {
  activo: boolean;
  bloqueado: boolean;
  intentosFallidos: number;
  debeCambiarClave: boolean;
}

export interface ParametroVista {
  clave: string;
  descripcion: string;
  unidad: string;
  valor: number;
  porDefecto: number;
  minimo: number;
  maximo: number;
  modificado: boolean;
}

export interface MotivoVista {
  id: string;
  tipoOperacion: TipoOperacion;
  nombre: string;
  exigeEvidencia: boolean;
  activo: boolean;
}

export interface RegistroBitacoraVista {
  seq: string;
  instante: string;
  actorTipo: "USUARIO" | "SISTEMA";
  usuarioLogin: string | null;
  modulo: string;
  evento: string;
  entidad: string | null;
  entidadId: string | null;
  detalle: unknown;
  origen: string | null;
}

export interface UbicacionVista {
  id: string;
  codigo: string;
  activa: boolean;
  capacidad: number | null;
  unidadCapacidad: UnidadMedida | null;
}

export interface ZonaVista {
  id: string;
  codigo: string;
  nombre: string;
  tipo: ZonaTipo;
  ubicaciones: UbicacionVista[];
}

export interface BodegaVista {
  id: string;
  codigo: string;
  nombre: string;
  zonas: ZonaVista[];
}

export interface ReferenciaDetalle extends ReferenciaResumen {
  tallas: string[];
  colores: string[];
}
