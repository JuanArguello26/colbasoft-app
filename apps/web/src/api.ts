import type {
  BodegaVista, DesviacionVista, ExistenciaReferencia, KardexVista, PiezasDeLoteVista, UbicacionDeReferencia, DocumentoEntradaResumen, DocumentoEntradaVista, EstadoExistencia, EtiquetaVista, PropuestaUbicacion, TipoPieza, IdentificadorResumen, LoteVista, ModoIdentificacion, ResolucionVista, SkuVista, MotivoVista, ParametroVista, ReferenciaDetalle, ReferenciaResumen, RegistroBitacoraVista,
  Rol, SesionInfo, TipoOperacion, UnidadMedida, UsuarioAdmin, UsuarioSesion, ZonaTipo,
} from "@colbasoft/shared";

export class ErrorApi extends Error {
  constructor(public estado: number, mensaje: string, public codigo?: string, public cuerpo?: Record<string, unknown>) {
    super(mensaje);
  }
}

let alActividad: (() => void) | null = null;
/** La aplicación se suscribe para refrescar el estado de la sesión tras cada operación que cuenta como actividad. */
export const suscribirActividad = (f: () => void) => { alActividad = f; };

async function pedir<T>(ruta: string, init?: RequestInit, pasivo = false): Promise<T> {
  // El servidor rechaza (400) un cuerpo JSON vacío: la cabecera solo se envía cuando hay cuerpo (logout, renovar, desactivar… no lo llevan).
  const r = await fetch(ruta, { credentials: "same-origin", ...init, headers: init?.body !== undefined ? { "Content-Type": "application/json" } : {} });
  if (!r.ok) {
    const c = (await r.json().catch(() => ({}))) as { error?: string; codigo?: string };
    throw new ErrorApi(r.status, c.error ?? "Error inesperado.", c.codigo, c);
  }
  if (!pasivo) alActividad?.();
  return r.json() as Promise<T>;
}
const cuerpo = (o: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(o) });
const enviar = (metodo: string, o?: unknown): RequestInit => ({ method: metodo, ...(o !== undefined ? { body: JSON.stringify(o) } : {}) });

export interface Conjunto { id: string; nombre: string }
export interface UsuarioCreado { usuario: UsuarioAdmin; claveTemporal: string }

export const api = {
  // sesión
  yo: () => pedir<SesionInfo>("/api/auth/yo", undefined, true),
  login: (login: string, clave: string) => pedir<UsuarioSesion & { debeCambiarClave: boolean }>("/api/auth/login", cuerpo({ login, clave }), true),
  logout: () => pedir<{ ok: boolean }>("/api/auth/logout", { method: "POST" }, true),
  renovar: () => pedir<{ ok: boolean }>("/api/auth/renovar", { method: "POST" }, true),
  cambiarClave: (claveActual: string, claveNueva: string) => pedir<{ ok: boolean }>("/api/auth/cambiar-clave", cuerpo({ claveActual, claveNueva })),
  // usuarios
  usuarios: () => pedir<UsuarioAdmin[]>("/api/usuarios"),
  crearUsuario: (d: { login: string; nombre: string; rol: Rol }) => pedir<UsuarioCreado>("/api/usuarios", cuerpo(d)),
  usuarioAccion: (id: string, accion: "desactivar" | "reactivar" | "desbloquear") => pedir<{ ok: boolean; claveTemporal?: string }>(`/api/usuarios/${id}/${accion}`, { method: "POST" }),
  // catálogo
  referencias: () => pedir<ReferenciaResumen[]>("/api/catalogo/referencias"),
  referencia: (id: string) => pedir<ReferenciaDetalle>(`/api/catalogo/referencias/${id}`),
  crearReferencia: (d: { codigo: string; descripcion: string; categoriaId: string; unidadMedida: UnidadMedida; tallaIds: string[]; colorIds: string[] }) => pedir<ReferenciaResumen>("/api/catalogo/referencias", cuerpo(d)),
  editarReferencia: (id: string, d: { descripcion?: string; categoriaId?: string; unidadMedida?: UnidadMedida }) => pedir<ReferenciaResumen>(`/api/catalogo/referencias/${id}`, enviar("PATCH", d)),
  referenciaAccion: (id: string, accion: "desactivar" | "reactivar") => pedir<{ ok: boolean }>(`/api/catalogo/referencias/${id}/${accion}`, { method: "POST" }),
  conjunto: (tipo: "categorias" | "tallas" | "colores") => pedir<Conjunto[]>(`/api/catalogo/${tipo}`),
  crearConjunto: (tipo: "categorias" | "tallas" | "colores", nombre: string) => pedir<Conjunto>(`/api/catalogo/${tipo}`, cuerpo({ nombre })),
  // bodega
  bodegas: () => pedir<BodegaVista[]>("/api/bodega"),
  pendientesCapacidad: () => pedir<Array<{ id: string; codigo: string; zona: string }>>("/api/bodega/ubicaciones/pendientes-capacidad"),
  crearBodega: (d: { codigo: string; nombre: string; zonaRecepcion: { codigo: string; nombre: string; ubicacionCodigo: string } }) => pedir<{ id: string }>("/api/bodega/bodegas", cuerpo(d)),
  crearZona: (bodegaId: string, d: { codigo: string; nombre: string; tipo: ZonaTipo }) => pedir<{ id: string }>(`/api/bodega/bodegas/${bodegaId}/zonas`, cuerpo(d)),
  crearUbicacion: (zonaId: string, d: { codigo: string; capacidad?: number; unidadCapacidad?: UnidadMedida }) => pedir<{ id: string }>(`/api/bodega/zonas/${zonaId}/ubicaciones`, cuerpo(d)),
  capacidad: (id: string, d: { capacidad: number | null; unidadCapacidad: UnidadMedida | null }) => pedir<{ ok: boolean }>(`/api/bodega/ubicaciones/${id}/capacidad`, enviar("PATCH", d)),
  ubicacionAccion: (id: string, accion: "desactivar" | "reactivar") => pedir<{ ok: boolean }>(`/api/bodega/ubicaciones/${id}/${accion}`, { method: "POST" }),
  // lotes e identificación (C1-2)
  skus: () => pedir<SkuVista[]>("/api/lotes/skus"),
  lotes: (q: { skuId?: string; q?: string } = {}) => pedir<LoteVista[]>(`/api/lotes?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  crearLote: (d: { skuId: string; codigo: string; origen: string }) => pedir<LoteVista>("/api/lotes", cuerpo(d)),
  generarQrMercancia: (loteId: string) => pedir<IdentificadorResumen>("/api/identificadores/mercancia", cuerpo({ loteId })),
  generarQrUbicaciones: (d: { zonaId: string } | { ubicacionIds: string[] }) => pedir<{ identificadores: IdentificadorResumen[]; nuevos: number }>("/api/identificadores/ubicaciones", cuerpo(d)),
  etiquetas: (ids: string[]) => pedir<EtiquetaVista[]>(`/api/identificadores/etiquetas?ids=${ids.join(",")}`),
  /** Resuelve un código escaneado o digitado. Los rechazos esperados (desconocido, anulado) vuelven como resultado, no como excepción. */
  resolver: async (codigo: string, modo: ModoIdentificacion): Promise<{ ok: true; datos: ResolucionVista } | { ok: false; mensaje: string; ofrecerNovedad: boolean; anulado: boolean }> => {
    const r = await fetch("/api/identificadores/resolver", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codigo, modo }) });
    const c = (await r.json().catch(() => ({}))) as { error?: string; ofrecerNovedad?: boolean; estado?: string };
    alActividad?.();
    if (r.ok) return { ok: true, datos: c as unknown as ResolucionVista };
    if (r.status === 404 || r.status === 409) return { ok: false, mensaje: c.error ?? "No se pudo resolver el código.", ofrecerNovedad: c.ofrecerNovedad === true, anulado: c.estado === "ANULADO" };
    throw new ErrorApi(r.status, c.error ?? "Error inesperado.");
  },
  // entradas, piezas y ubicación (C1-3)
  entradas: (estado?: string) => pedir<DocumentoEntradaResumen[]>(`/api/entradas${estado ? `?estado=${estado}` : ""}`),
  entrada: (id: string) => pedir<DocumentoEntradaVista>(`/api/entradas/${id}`),
  crearEntrada: (d: { bodegaId: string; origen: string; fechaEsperada: string; lineas: Array<{ skuId: string; cantidad: number }>; confirmarDuplicado?: boolean }) => pedir<DocumentoEntradaVista>("/api/entradas", cuerpo(d)),
  registrarPieza: (id: string, d: { lineaId: string; tipo: TipoPieza; cantidad: number }) => pedir<DocumentoEntradaVista>(`/api/entradas/${id}/piezas`, cuerpo(d)),
  cerrarRecepcion: (id: string) => pedir<DocumentoEntradaVista>(`/api/entradas/${id}/cerrar-recepcion`, { method: "POST" }),
  autorizarSobrante: (id: string) => pedir<DocumentoEntradaVista>(`/api/entradas/${id}/autorizar-sobrante`, { method: "POST" }),
  confirmarEntrada: (id: string, lotes: Array<{ lineaId: string; loteId?: string; codigo?: string; origen?: string }>) => pedir<DocumentoEntradaVista>(`/api/entradas/${id}/confirmar`, cuerpo({ lotes })),
  propuesta: (piezaId: string) => pedir<PropuestaUbicacion>(`/api/entradas/piezas/${piezaId}/propuesta`),
  ubicarPieza: (piezaId: string, d: { destinoCodigo?: string; destinoId?: string; mercanciaCodigo?: string }) => pedir<{ movimientoId: string; desviacion: boolean; destino: string; estado: EstadoExistencia; modo: ModoIdentificacion }>(`/api/entradas/piezas/${piezaId}/ubicar`, cuerpo(d)),
  desviaciones: () => pedir<DesviacionVista[]>("/api/entradas/desviaciones"),
  zonaCategoria: (zonaId: string, categoriaId: string | null) => pedir<{ ok: boolean }>(`/api/bodega/zonas/${zonaId}/categoria`, enviar("PATCH", { categoriaId })),
  // existencia y kardex (C1-4)
  existencia: (q: Record<string, string>) => pedir<ExistenciaReferencia[]>(`/api/inventario/existencia?${new URLSearchParams(q)}`, undefined, true),
  dondeEsta: (q: Record<string, string>) => pedir<UbicacionDeReferencia[]>(`/api/inventario/donde-esta?${new URLSearchParams(q)}`, undefined, true),
  piezasDeLote: (loteId: string) => pedir<PiezasDeLoteVista>(`/api/inventario/lotes/${loteId}/piezas`, undefined, true),
  kardex: (q: Record<string, string>) => pedir<KardexVista>(`/api/inventario/kardex?${new URLSearchParams(q)}`, undefined, true),
  urlKardexCsv: (q: Record<string, string>) => `/api/inventario/kardex?${new URLSearchParams({ ...q, formato: "csv" })}`,
  anularMovimiento: (movimientoId: string, motivoId: string) => pedir<{ anulado: number; inverso: number }>(`/api/inventario/movimientos/${movimientoId}/anular`, cuerpo({ motivoId })),
  // parámetros y motivos
  parametros: () => pedir<ParametroVista[]>("/api/parametros"),
  guardarParametro: (clave: string, valor: number) => pedir<{ clave: string; anterior: number; nuevo: number }>(`/api/parametros/${clave}`, enviar("PUT", { valor })),
  motivos: () => pedir<MotivoVista[]>("/api/motivos"),
  crearMotivo: (d: { tipoOperacion: TipoOperacion; nombre: string; exigeEvidencia: boolean }) => pedir<MotivoVista>("/api/motivos", cuerpo(d)),
  editarMotivo: (id: string, d: { nombre?: string; exigeEvidencia?: boolean }) => pedir<MotivoVista>(`/api/motivos/${id}`, enviar("PATCH", d)),
  motivoAccion: (id: string, accion: "desactivar" | "reactivar") => pedir<{ ok: boolean }>(`/api/motivos/${id}/${accion}`, { method: "POST" }),
  // bitácora
  bitacora: (q: Record<string, string>) => pedir<RegistroBitacoraVista[]>(`/api/bitacora?${new URLSearchParams(q)}`),
  continuidad: () => pedir<{ ok: boolean; registros: number; hallazgos: Array<{ seq: string; problema: string }> }>("/api/bitacora/continuidad"),
  urlExportar: (q: Record<string, string>) => `/api/bitacora/exportar?${new URLSearchParams(q)}`,
};
