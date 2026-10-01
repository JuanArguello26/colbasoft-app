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
  /** Categoría que esta zona recibe en la propuesta de ubicación (RN-MOV-001). */
  categoriaId: string | null;
  categoria: string | null;
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

export const IDENTIFICADOR_TIPOS = ["MERCANCIA", "UBICACION"] as const;
export type IdentificadorTipo = (typeof IDENTIFICADOR_TIPOS)[number];
export type IdentificadorEstado = "ACTIVO" | "ANULADO";
/** RF-QRC-009: cómo se identificó algo, por escaneo o por selección o digitación manual. */
export type ModoIdentificacion = "ESCANEO" | "MANUAL";

export interface SkuVista {
  id: string;
  referencia: string;
  descripcion: string;
  talla: string;
  color: string;
  unidadMedida: UnidadMedida;
}

export interface IdentificadorResumen {
  id: string;
  codigo: string;
  tipo: IdentificadorTipo;
  estado: IdentificadorEstado;
  loteId: string | null;
  ubicacionId: string | null;
}

export interface LoteVista {
  id: string;
  codigo: string;
  origen: string;
  fechaIngreso: string;
  sku: SkuVista;
  identificador: { id: string; codigo: string; estado: IdentificadorEstado } | null;
}

/** Datos de una etiqueta imprimible: el QR y la información legible de respaldo (HU-QRC-001 criterio 3). */
export interface EtiquetaVista {
  id: string;
  codigo: string;
  tipo: IdentificadorTipo;
  estado: IdentificadorEstado;
  /** Imagen SVG del QR, generada por el servidor. */
  svg: string;
  /** Mercancía: referencia, talla, color y lote. */
  mercancia?: { referencia: string; descripcion: string; talla: string; color: string; lote: string };
  /** Ubicación: bodega, zona y código. */
  ubicacion?: { bodega: string; zona: string; codigo: string };
}

export type EstadoExistencia = "EN_RECEPCION" | "DISPONIBLE";

export interface ExistenciaEnUbicacion {
  ubicacionId: string;
  ubicacion: string;
  estado: EstadoExistencia;
  cantidad: number;
}

/** Resultado de resolver un identificador escaneado o digitado (HU-QRC-002). */
export type ResolucionVista =
  | {
      tipo: "MERCANCIA";
      identificador: { codigo: string; estado: IdentificadorEstado };
      sku: SkuVista;
      lote: { id: string; codigo: string; origen: string; fechaIngreso: string };
      /** Ubicaciones donde el SKU + Lote tiene existencia, con su estado. */
      ubicaciones: ExistenciaEnUbicacion[];
    }
  | {
      tipo: "UBICACION";
      identificador: { codigo: string; estado: IdentificadorEstado };
      ubicacion: { id: string; codigo: string; zona: string; bodega: string; activa: boolean };
    };

// ---- Entradas, piezas y ubicación (bloque C1-3) ----

export const ESTADOS_DOCUMENTO_ENTRADA = ["PENDIENTE_RECEPCION", "RECEPCION_PARCIAL", "RECIBIDO_CONFORME", "RECIBIDO_CON_NOVEDAD", "CONFIRMADO"] as const;
export type EstadoDocumentoEntrada = (typeof ESTADOS_DOCUMENTO_ENTRADA)[number];

export const TIPOS_PIEZA = ["ROLLO", "PAQUETE", "BOLSA"] as const;
export type TipoPieza = (typeof TIPOS_PIEZA)[number];

/** F-1: el rollo es la pieza de las referencias en metros, kilogramos o rollos; paquete o bolsa, la de las referencias en unidades. */
export const TIPOS_PIEZA_POR_UNIDAD: Record<UnidadMedida, readonly TipoPieza[]> = {
  UNIDADES: ["PAQUETE", "BOLSA"],
  METROS: ["ROLLO"],
  KILOGRAMOS: ["ROLLO"],
  ROLLOS: ["ROLLO"],
};

/** Resultado de comparar lo recibido con lo esperado en una línea (RN-ENT-003). */
export type ResultadoLinea = "SIN_RECIBIR" | "EN_CURSO" | "CONFORME" | "FALTANTE" | "SOBRANTE";

export interface PiezaVista {
  id: string;
  numero: number;
  tipo: TipoPieza;
  /** Cantidad con la que se recibió. */
  cantidad: number;
  registradaPor: string;
  registradaEn: string;
  /** Dónde está hoy, derivado del kardex. */
  ubicaciones: ExistenciaEnUbicacion[];
}

export interface LineaEntradaVista {
  id: string;
  sku: SkuVista;
  cantidadEsperada: number;
  /** Suma de las cantidades de sus piezas (RN-LOT-007). */
  cantidadRecibida: number;
  diferencia: number | null;
  resultado: ResultadoLinea;
  lote: { id: string; codigo: string } | null;
  piezas: PiezaVista[];
}

export interface DocumentoEntradaResumen {
  id: string;
  numero: number;
  origen: string;
  fechaEsperada: string;
  estado: EstadoDocumentoEntrada;
  bodega: string;
  lineas: number;
  creadoEn: string;
  tieneFaltante: boolean;
  tieneSobrante: boolean;
}

export interface DocumentoEntradaVista extends DocumentoEntradaResumen {
  bodegaId: string;
  creadoPor: string;
  llegadaEn: string | null;
  receptores: string[];
  sobranteAutorizado: { por: string; en: string } | null;
  confirmado: { por: string; en: string } | null;
  ubicacionRecepcion: string | null;
  detalle: LineaEntradaVista[];
}

export interface PropuestaUbicacion {
  ubicacion: { id: string; codigo: string; zona: string; bodega: string };
  criterio: "AGRUPACION_POR_REFERENCIA" | "ZONA_POR_CATEGORIA" | "RECEPCION";
  explicacion: string;
}

/** RN-MOV-003: desviación entre la ubicación propuesta y la confirmada; información operativa, no falta imputable. */
export interface DesviacionVista {
  movimientoId: string;
  instante: string;
  usuario: string;
  documento: number;
  pieza: number;
  propuesta: string | null;
  elegida: string;
}

// ---- Kardex y consulta de existencia (bloque C1-4) ----

/** RF-INV-002: el desglose siempre muestra los cinco estados; los que aún no existen en el corte C1 valen 0. */
export const ESTADOS_DESGLOSE = ["DISPONIBLE", "RESERVADO", "INMOVILIZADO", "EN_TRANSITO", "EN_RECEPCION"] as const;
export type EstadoDesglose = (typeof ESTADOS_DESGLOSE)[number];
export type DesgloseEstados = Record<EstadoDesglose, number>;

export interface ExistenciaDetalle {
  sku: SkuVista;
  lote: { id: string; codigo: string };
  porEstado: DesgloseEstados;
  total: number;
}

export interface ExistenciaReferencia {
  referenciaId: string;
  codigo: string;
  descripcion: string;
  unidadMedida: UnidadMedida;
  porEstado: DesgloseEstados;
  total: number;
  /** Por talla, color y lote (HU-INV-001 criterio 1). Vacío si no hay existencia. */
  detalle: ExistenciaDetalle[];
}

/** HU-INV-003: una fila por ubicación, SKU, lote y estado; la que no está disponible va marcada. */
export interface UbicacionDeReferencia {
  ubicacionId: string;
  ubicacion: string;
  zona: string;
  sku: SkuVista;
  lote: { id: string; codigo: string };
  estado: EstadoDesglose;
  cantidad: number;
  disponible: boolean;
}

export type TipoMovimientoVista = "ENTRADA" | "MOVIMIENTO_INTERNO" | "ANULACION";

/** Una línea del kardex: responde qué, cuánto, dónde, quién, cuándo y por qué (CD-21). */
export interface LineaKardex {
  movimientoId: string;
  secuencia: number;
  instante: string;
  tipo: TipoMovimientoVista;
  /** Con signo: lo que el asiento suma o resta. */
  cantidad: number;
  /** Suma acumulada de las cantidades dentro de lo consultado, hasta esta línea. */
  existenciaResultante: number;
  estado: EstadoDesglose;
  ubicacion: string;
  pieza: number;
  sku: SkuVista;
  lote: string;
  usuario: string;
  /** Número del documento de entrada que originó el movimiento, si lo hubo. */
  documento: number | null;
  /** Motivo tipificado: solo las anulaciones lo llevan en C1. */
  motivo: string | null;
  /** Secuencia del movimiento que esta anulación neutraliza. */
  anulaA: number | null;
  /** Secuencia de la anulación que neutralizó este movimiento. */
  anuladoPor: number | null;
}

export interface KardexVista {
  lineas: LineaKardex[];
  /** Existencia al final de lo consultado. */
  existenciaFinal: number;
  /** HU-KDX-001 criterio 4: cada línea es la anterior más su cantidad y la existencia nunca queda por debajo de cero. */
  continuidad: { ok: boolean; lineas: number };
  truncado: boolean;
  /** El Auxiliar solo ve lo que él movió y los últimos 30 días. */
  restringido: boolean;
}

export interface PiezaDeLoteVista extends PiezaVista {
  /** Lo que queda de la pieza hoy: la suma de sus asientos en el kardex. */
  cantidadActual: number;
}

export interface PiezasDeLoteVista {
  lote: { id: string; codigo: string; sku: SkuVista };
  piezas: PiezaDeLoteVista[];
}

// ---- Movimientos internos (bloque C1-5) ----

/** Una pieza con existencia, ofrecida para moverla (HU-MOV-008): dónde está hoy y si se puede mover. */
export interface PiezaMovible {
  id: string;
  numero: number;
  tipo: TipoPieza;
  /** Lo que tiene la pieza en esa ubicación y estado. */
  cantidad: number;
  ubicacionId: string;
  ubicacion: string;
  estado: EstadoExistencia;
  /** Solo la existencia disponible se mueve con un movimiento interno. */
  movible: boolean;
}

export interface PiezasMovibles {
  lote: { id: string; codigo: string; sku: SkuVista };
  piezas: PiezaMovible[];
}

export interface MovimientoInternoResultado {
  movimientoId: string;
  secuencia: number;
  pieza: number;
  cantidad: number;
  origen: string;
  destino: string;
  modo: ModoIdentificacion;
}
