import type { ReferenciaResumen, UsuarioSesion } from "@colbasoft/shared";

async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
  const r = await fetch(ruta, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    const cuerpo = (await r.json().catch(() => ({}))) as { error?: string };
    throw new ErrorApi(r.status, cuerpo.error ?? "Error inesperado.");
  }
  return r.json() as Promise<T>;
}

export class ErrorApi extends Error {
  constructor(public estado: number, mensaje: string) {
    super(mensaje);
  }
}

export const api = {
  yo: () => pedir<UsuarioSesion>("/api/auth/yo"),
  login: (login: string, clave: string) => pedir<UsuarioSesion>("/api/auth/login", { method: "POST", body: JSON.stringify({ login, clave }) }),
  logout: () => pedir<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  referencias: () => pedir<ReferenciaResumen[]>("/api/catalogo/referencias"),
};
