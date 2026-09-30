import type {
  BodegaVista, MotivoVista, ParametroVista, ReferenciaDetalle, ReferenciaResumen, RegistroBitacoraVista,
  Rol, SesionInfo, TipoOperacion, UnidadMedida, UsuarioAdmin, UsuarioSesion, ZonaTipo,
} from "@colbasoft/shared";

export class ErrorApi extends Error {
  constructor(public estado: number, mensaje: string, public codigo?: string) {
    super(mensaje);
  }
}

let alActividad: (() => void) | null = null;
/** La aplicación se suscribe para refrescar el estado de la sesión tras cada operación que cuenta como actividad. */
export const suscribirActividad = (f: () => void) => { alActividad = f; };

async function pedir<T>(ruta: string, init?: RequestInit, pasivo = false): Promise<T> {
  const r = await fetch(ruta, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    const c = (await r.json().catch(() => ({}))) as { error?: string; codigo?: string };
    throw new ErrorApi(r.status, c.error ?? "Error inesperado.", c.codigo);
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
