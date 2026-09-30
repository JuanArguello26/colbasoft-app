import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Carga de datos con estado de espera y de error. `recargar` vuelve a pedir. */
export function useCarga<T>(pedir: () => Promise<T>, dependencias: unknown[] = []) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recargar = useCallback(() => {
    setCargando(true);
    pedir().then((d) => { setDatos(d); setError(""); }).catch((e: Error) => setError(e.message)).finally(() => setCargando(false));
  }, dependencias);
  useEffect(() => { recargar(); }, [recargar]);
  return { datos, error, cargando, recargar };
}

export function Aviso({ tipo, children }: { tipo: "error" | "ok" | "info"; children: ReactNode }) {
  return <p className={`aviso ${tipo}`} role={tipo === "error" ? "alert" : "status"}>{children}</p>;
}

export function Campo({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return <label className="campo"><span>{etiqueta}</span>{children}</label>;
}

export function Insignia({ tono, children }: { tono?: "ok" | "alerta" | "gris" | "info"; children: ReactNode }) {
  return <span className={`insignia ${tono ?? "gris"}`}>{children}</span>;
}

export function Modal({ titulo, alCerrar, children }: { titulo: string; alCerrar: () => void; children: ReactNode }) {
  return (
    <div className="modal-fondo" role="dialog" aria-modal="true" aria-label={titulo}>
      <div className="modal">
        <div className="modal-cabecera"><h2>{titulo}</h2><button className="secundario" onClick={alCerrar}>Cerrar</button></div>
        {children}
      </div>
    </div>
  );
}

export const fechaHora = (iso: string) => new Date(iso).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium" });
