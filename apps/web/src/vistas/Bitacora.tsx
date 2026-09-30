import { useState } from "react";
import { api } from "../api";
import { Aviso, Campo, fechaHora, useCarga } from "../ui";

export function Bitacora({ puedeExportar }: { puedeExportar: boolean }) {
  const [f, setF] = useState({ usuario: "", evento: "", modulo: "", desde: "", hasta: "" });
  const [aplicado, setAplicado] = useState<Record<string, string>>({});
  const { datos, error, cargando } = useCarga(() => api.bitacora(aplicado), [JSON.stringify(aplicado)]);
  const [integridad, setIntegridad] = useState<Awaited<ReturnType<typeof api.continuidad>> | null>(null);
  const [errInt, setErrInt] = useState("");

  const limpio = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Record<string, string>;
  async function verificar() {
    setErrInt(""); setIntegridad(null);
    try { setIntegridad(await api.continuidad()); } catch (e) { setErrInt((e as Error).message); }
  }

  return (
    <section>
      <h2>Bitácora de auditoría</h2>
      <p className="nota">Registro inmutable de accesos, cambios de configuración y de rol, exportaciones y demás eventos. Nadie puede editarlo ni borrarlo, ni siquiera el Administrador.</p>
      <form className="rejilla" onSubmit={(e) => { e.preventDefault(); setAplicado(limpio()); }}>
        <Campo etiqueta="Usuario"><input value={f.usuario} onChange={(e) => setF({ ...f, usuario: e.target.value })} /></Campo>
        <Campo etiqueta="Módulo"><input value={f.modulo} onChange={(e) => setF({ ...f, modulo: e.target.value.toUpperCase() })} placeholder="ACCESO, USUARIOS…" /></Campo>
        <Campo etiqueta="Evento"><input value={f.evento} onChange={(e) => setF({ ...f, evento: e.target.value })} placeholder="acceso_fallido" /></Campo>
        <Campo etiqueta="Desde"><input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /></Campo>
        <Campo etiqueta="Hasta"><input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></Campo>
        <button type="submit">Filtrar</button>
      </form>
      {puedeExportar && (
        <div className="acciones">
          <button className="secundario" onClick={verificar}>Verificar continuidad</button>
          <a className="boton secundario" href={api.urlExportar(limpio())}>Exportar CSV</a>
        </div>
      )}
      {errInt && <Aviso tipo="error">{errInt}</Aviso>}
      {integridad && (integridad.ok
        ? <Aviso tipo="ok">Cadena íntegra: {integridad.registros} {integridad.registros === 1 ? "registro" : "registros"} sin discontinuidades.</Aviso>
        : <Aviso tipo="error"><strong>Hallazgo crítico:</strong> se detectaron {integridad.hallazgos.length} discontinuidades. Primer registro afectado: {integridad.hallazgos[0]?.seq}.</Aviso>)}
      {error && <Aviso tipo="error">{error}</Aviso>}
      {cargando && <p>Cargando…</p>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>#</th><th>Fecha</th><th>Usuario</th><th>Módulo</th><th>Evento</th><th>Detalle</th></tr></thead>
          <tbody>
            {(datos ?? []).map((r) => (
              <tr key={r.seq}>
                <td>{r.seq}</td><td>{fechaHora(r.instante)}</td>
                <td>{r.actorTipo === "SISTEMA" ? <em>Sistema</em> : r.usuarioLogin ?? "—"}</td>
                <td>{r.modulo}</td><td>{r.evento}</td>
                <td className="detalle">{r.detalle ? JSON.stringify(r.detalle) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
