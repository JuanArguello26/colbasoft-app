import { useState, type FormEvent } from "react";
import type { LoteVista, SkuVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, Modal, fechaHora, useCarga } from "../ui";
import { Etiquetas } from "./Etiquetas";

const nombreSku = (s: SkuVista) => `${s.referencia} · ${s.descripcion} · ${s.talla} · ${s.color}`;

/** Lotes y códigos QR de la mercancía (HU-LOT-001, HU-QRC-001). Quien no genera (Auxiliar, Auditor) solo consulta. */
export function Identificacion({ puedeGenerar }: { puedeGenerar: boolean }) {
  const [filtro, setFiltro] = useState("");
  const { datos, error, recargar } = useCarga(() => api.lotes({ q: filtro }), [filtro]);
  const [nuevo, setNuevo] = useState(false);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [imprimir, setImprimir] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");

  const alternar = (id: string) => setElegidos((a) => { const b = new Set(a); if (b.has(id)) b.delete(id); else b.add(id); return b; });

  async function generar(l: LoteVista) {
    setMsg("");
    try { await api.generarQrMercancia(l.id); recargar(); } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <section>
      <div className="cabecera">
        <h2>Lotes y códigos QR</h2>
        {puedeGenerar && <button onClick={() => setNuevo(true)}>Nuevo lote</button>}
      </div>
      <p className="nota">El QR identifica el SKU + Lote: no cambia con la ubicación ni con la cantidad. Hoy el lote se crea aquí; con el bloque de entradas se creará al confirmar la entrada.</p>
      <div className="acciones">
        <input className="buscar" placeholder="Buscar por lote, origen o referencia" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        {puedeGenerar && <button className="secundario" disabled={elegidos.size === 0} onClick={() => setImprimir([...elegidos])}>Imprimir seleccionados ({elegidos.size})</button>}
      </div>
      {msg && <Aviso tipo="error">{msg}</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr>{puedeGenerar && <th></th>}<th>Lote</th><th>SKU</th><th>Origen</th><th>Ingreso</th><th>Identificador QR</th><th></th></tr></thead>
          <tbody>
            {(datos ?? []).map((l) => (
              <tr key={l.id}>
                {puedeGenerar && <td><input type="checkbox" aria-label={`Seleccionar ${l.codigo}`} disabled={!l.identificador} checked={!!l.identificador && elegidos.has(l.identificador.id)} onChange={() => l.identificador && alternar(l.identificador.id)} /></td>}
                <td><strong>{l.codigo}</strong></td>
                <td>{nombreSku(l.sku)}</td>
                <td>{l.origen}</td>
                <td>{fechaHora(l.fechaIngreso)}</td>
                <td>{l.identificador ? <><code>{l.identificador.codigo}</code> {l.identificador.estado === "ACTIVO" ? <Insignia tono="ok">Activo</Insignia> : <Insignia>Anulado</Insignia>}</> : <Insignia tono="alerta">Sin QR</Insignia>}</td>
                <td className="acciones">
                  {puedeGenerar && !l.identificador && <button className="secundario" onClick={() => generar(l)}>Generar QR</button>}
                  {puedeGenerar && l.identificador && <button className="secundario" onClick={() => setImprimir([l.identificador!.id])}>Imprimir</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(datos ?? []).length === 0 && <p className="nota">No hay lotes que coincidan.</p>}
      </div>
      {nuevo && <FormLote alCerrar={() => setNuevo(false)} alGuardar={() => { setNuevo(false); recargar(); }} />}
      {imprimir && <Etiquetas ids={imprimir} alCerrar={() => setImprimir(null)} />}
    </section>
  );
}

function FormLote({ alCerrar, alGuardar }: { alCerrar: () => void; alGuardar: () => void }) {
  const skus = useCarga(api.skus);
  const [skuId, setSkuId] = useState("");
  const [codigo, setCodigo] = useState("");
  const [origen, setOrigen] = useState("");
  const [error, setError] = useState("");

  async function enviar(e: FormEvent) {
    e.preventDefault(); setError("");
    try { await api.crearLote({ skuId, codigo, origen }); alGuardar(); } catch (err) { setError((err as Error).message); }
  }
  return (
    <Modal titulo="Nuevo lote" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="SKU">
          <select value={skuId} onChange={(e) => setSkuId(e.target.value)}>
            <option value="">Elija un SKU…</option>
            {(skus.datos ?? []).map((s) => <option key={s.id} value={s.id}>{nombreSku(s)}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Código del lote"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={40} /></Campo>
        <Campo etiqueta="Origen (proveedor o procedencia)"><input value={origen} onChange={(e) => setOrigen(e.target.value)} maxLength={120} /></Campo>
        <p className="nota">La fecha de ingreso se registra sola. El código debe ser único dentro del SKU.</p>
        {skus.error && <Aviso tipo="error">{skus.error}</Aviso>}
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={!skuId || !codigo.trim() || origen.trim().length < 2}>Crear lote</button>
      </form>
    </Modal>
  );
}
