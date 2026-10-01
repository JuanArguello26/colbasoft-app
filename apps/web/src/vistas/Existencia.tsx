import { useState, type FormEvent } from "react";
import { ESTADOS_DESGLOSE, type DesgloseEstados, type ExistenciaReferencia, type UbicacionDeReferencia } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia } from "../ui";

export const NOMBRE_ESTADO: Record<keyof DesgloseEstados, string> = {
  DISPONIBLE: "Disponible", RESERVADO: "Reservado", INMOVILIZADO: "Inmovilizado", EN_TRANSITO: "En tránsito", EN_RECEPCION: "En recepción",
};

function Desglose({ d }: { d: DesgloseEstados }) {
  return <>{ESTADOS_DESGLOSE.map((e) => <td key={e} className={d[e] === 0 ? "suave" : ""}>{d[e]}</td>)}</>;
}

/** Consulta de existencia (HU-INV-001, HU-INV-003). Solo lee: la cifra se deriva del kardex. */
export function Existencia({ alVerKardex }: { alVerKardex: (loteId: string) => void }) {
  const [q, setQ] = useState("");
  const [resultado, setResultado] = useState<ExistenciaReferencia[] | null>(null);
  const [error, setError] = useState("");
  const [donde, setDonde] = useState<{ ref: ExistenciaReferencia; filas: UbicacionDeReferencia[] } | null>(null);
  const [orden, setOrden] = useState<"cantidad" | "zona">("cantidad");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [lote, setLote] = useState("");

  async function buscar(e: FormEvent) {
    e.preventDefault();
    setError(""); setDonde(null);
    try { setResultado(await api.existencia({ q })); } catch (err) { setError((err as Error).message); }
  }

  async function ubicaciones(ref: ExistenciaReferencia, filtros = { orden, talla, color, lote }) {
    setError("");
    try {
      const filas = await api.dondeEsta(Object.fromEntries(Object.entries({ referenciaId: ref.referenciaId, ...filtros }).filter(([, v]) => v)) as Record<string, string>);
      setDonde({ ref, filas });
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <section>
      <h2>Existencia</h2>
      <p className="nota">Escriba el código o la descripción de una referencia. La cifra sale siempre del kardex.</p>
      <form onSubmit={buscar} className="rejilla">
        <Campo etiqueta="Referencia"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código o descripción" autoFocus /></Campo>
        <button type="submit" disabled={!q.trim()}>Consultar</button>
      </form>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {resultado?.length === 0 && <p className="nota">No hay referencias que coincidan.</p>}
      {resultado?.map((r) => (
        <article key={r.referenciaId} className="bloque">
          <div className="cabecera">
            <h3>{r.codigo} <small>{r.descripcion} · {r.unidadMedida.toLowerCase()}</small></h3>
            <div className="acciones"><strong>Total {r.total}</strong> <button className="secundario" onClick={() => void ubicaciones(r)}>Dónde está</button></div>
          </div>
          {r.detalle.length === 0 ? <p className="nota">Sin existencia.</p> : (
            <div className="tabla-envoltura">
              <table>
                <thead><tr><th>Talla</th><th>Color</th><th>Lote</th>{ESTADOS_DESGLOSE.map((e) => <th key={e}>{NOMBRE_ESTADO[e]}</th>)}<th>Total</th><th></th></tr></thead>
                <tbody>
                  {r.detalle.map((d) => (
                    <tr key={`${d.sku.id}${d.lote.id}`}>
                      <td>{d.sku.talla}</td><td>{d.sku.color}</td><td>{d.lote.codigo}</td><Desglose d={d.porEstado} /><td><strong>{d.total}</strong></td>
                      <td className="acciones"><button className="secundario" onClick={() => alVerKardex(d.lote.id)}>Kardex</button></td>
                    </tr>
                  ))}
                  <tr><td colSpan={3}><strong>Todas</strong></td><Desglose d={r.porEstado} /><td><strong>{r.total}</strong></td><td></td></tr>
                </tbody>
              </table>
            </div>
          )}
          {donde?.ref.referenciaId === r.referenciaId && (
            <div className="bloque">
              <h4>Dónde está {r.codigo}</h4>
              <div className="rejilla">
                <Campo etiqueta="Ordenar por"><select value={orden} onChange={(e) => { const o = e.target.value as "cantidad" | "zona"; setOrden(o); void ubicaciones(r, { orden: o, talla, color, lote }); }}><option value="cantidad">Cantidad</option><option value="zona">Zona</option></select></Campo>
                <Campo etiqueta="Talla"><input value={talla} onChange={(e) => setTalla(e.target.value)} onBlur={() => void ubicaciones(r)} /></Campo>
                <Campo etiqueta="Color"><input value={color} onChange={(e) => setColor(e.target.value)} onBlur={() => void ubicaciones(r)} /></Campo>
                <Campo etiqueta="Lote"><input value={lote} onChange={(e) => setLote(e.target.value)} onBlur={() => void ubicaciones(r)} /></Campo>
              </div>
              {donde.filas.length === 0 ? <p className="nota">Ninguna ubicación cumple el filtro.</p> : (
                <div className="tabla-envoltura">
                  <table>
                    <thead><tr><th>Zona</th><th>Ubicación</th><th>Talla</th><th>Color</th><th>Lote</th><th>Cantidad</th><th>Estado</th></tr></thead>
                    <tbody>
                      {donde.filas.map((f) => (
                        <tr key={`${f.ubicacionId}${f.sku.id}${f.lote.id}${f.estado}`}>
                          <td>{f.zona}</td><td>{f.ubicacion}</td><td>{f.sku.talla}</td><td>{f.sku.color}</td><td>{f.lote.codigo}</td><td>{f.cantidad}</td>
                          <td>{f.disponible ? <Insignia tono="ok">Disponible</Insignia> : <Insignia tono="alerta">No disponible · {NOMBRE_ESTADO[f.estado].toLowerCase()}</Insignia>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
