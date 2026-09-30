import { useState, type FormEvent } from "react";
import { TIPOS_OPERACION, type TipoOperacion } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, useCarga } from "../ui";

const NOMBRE_TIPO: Record<TipoOperacion, string> = { AJUSTE: "Ajustes", ANULACION: "Anulaciones", SALIDA: "Salidas", DESCARTE_ALERTA: "Descarte de alertas" };

export function Motivos({ puedeEditar }: { puedeEditar: boolean }) {
  const { datos, error, recargar } = useCarga(api.motivos);
  const [tipo, setTipo] = useState<TipoOperacion>("AJUSTE");
  const [nombre, setNombre] = useState("");
  const [evidencia, setEvidencia] = useState(false);
  const [msg, setMsg] = useState("");

  async function crear(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    try { await api.crearMotivo({ tipoOperacion: tipo, nombre, exigeEvidencia: evidencia }); setNombre(""); setEvidencia(false); recargar(); }
    catch (err) { setMsg((err as Error).message); }
  }
  async function correr(f: () => Promise<unknown>) {
    setMsg("");
    try { await f(); recargar(); } catch (err) { setMsg((err as Error).message); }
  }

  return (
    <section>
      <h2>Motivos tipificados</h2>
      <p className="nota">Una causa elegida de una lista cerrada; el texto libre nunca la sustituye. Un motivo no se elimina: se desactiva, y deja de ofrecerse en operaciones nuevas sin desaparecer del historial.</p>
      {msg && <Aviso tipo="error">{msg}</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      {puedeEditar && (
        <form className="rejilla" onSubmit={crear}>
          <Campo etiqueta="Tipo de operación"><select value={tipo} onChange={(e) => setTipo(e.target.value as TipoOperacion)}>{TIPOS_OPERACION.map((t) => <option key={t} value={t}>{NOMBRE_TIPO[t]}</option>)}</select></Campo>
          <Campo etiqueta="Motivo"><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
          <label className="casilla"><input type="checkbox" checked={evidencia} onChange={(e) => setEvidencia(e.target.checked)} /> Exige evidencia adjunta</label>
          <button type="submit" disabled={nombre.trim().length < 3}>Agregar</button>
        </form>
      )}
      {TIPOS_OPERACION.map((t) => (
        <div key={t}>
          <h3>{NOMBRE_TIPO[t]}</h3>
          <ul className="lista">
            {(datos ?? []).filter((m) => m.tipoOperacion === t).map((m) => (
              <li key={m.id} className={m.activo ? "" : "apagado"}>
                <span>{m.nombre} {m.exigeEvidencia && <Insignia tono="info">Exige evidencia</Insignia>} {!m.activo && <Insignia>Desactivado</Insignia>}</span>
                {puedeEditar && (
                  <span className="acciones">
                    <button className="secundario" onClick={() => correr(() => api.editarMotivo(m.id, { exigeEvidencia: !m.exigeEvidencia }))}>{m.exigeEvidencia ? "Quitar evidencia" : "Exigir evidencia"}</button>
                    <button className="secundario" onClick={() => correr(() => api.motivoAccion(m.id, m.activo ? "desactivar" : "reactivar"))}>{m.activo ? "Desactivar" : "Reactivar"}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
