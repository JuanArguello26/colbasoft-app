import { useState, type FormEvent } from "react";
import type { PiezaMovible, PiezasMovibles } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, useCarga } from "../ui";
import { Lector } from "./Lector";

const PZ = (n: number) => `P-${String(n).padStart(6, "0")}`;

/**
 * Movimiento interno (HU-MOV-001, HU-MOV-002, HU-MOV-008): se escanea la mercancía, el sistema ofrece las piezas del lote, la persona elige la que mueve
 * y luego escanea la ubicación destino. La pieza se mueve completa. Cada rechazo explica el motivo.
 */
export function Mover() {
  const bodegas = useCarga(api.bodegas);
  const [mercancia, setMercancia] = useState("");
  const [origen, setOrigen] = useState("");
  const [destino, setDestino] = useState("");
  const [seleccion, setSeleccion] = useState("");
  const [piezaId, setPiezaId] = useState("");
  const [lote, setLote] = useState<PiezasMovibles | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const destinos = (bodegas.datos ?? []).flatMap((b) => b.zonas.filter((z) => z.tipo === "ALMACENAMIENTO" || z.tipo === "PREPARACION_SALIDA").flatMap((z) => z.ubicaciones.filter((u) => u.activa).map((u) => ({ id: u.id, texto: `${u.codigo} · ${z.nombre}` }))));

  async function buscar(e?: FormEvent, codigo = mercancia, ubic = origen) {
    e?.preventDefault();
    setError(""); setPiezaId("");
    try {
      setLote(await api.piezasMovibles({ mercanciaCodigo: codigo.trim(), ...(ubic.trim() ? { ubicacionCodigo: ubic.trim() } : {}) }));
    } catch (err) { setLote(null); setError((err as Error).message); }
  }

  async function mover(e: FormEvent) {
    e.preventDefault();
    setError(""); setOk("");
    try {
      const r = await api.moverPieza({
        piezaId, mercanciaCodigo: mercancia.trim(),
        ...(origen.trim() ? { origenCodigo: origen.trim() } : {}),
        ...(destino.trim() ? { destinoCodigo: destino.trim() } : { destinoId: seleccion }),
      });
      setOk(`Listo: ${PZ(r.pieza)} (${r.cantidad}) pasó de ${r.origen} a ${r.destino}. El total no cambió y el movimiento quedó en el kardex (n.º ${r.secuencia}).`);
      setDestino(""); setSeleccion("");
      await buscar();
    } catch (err) { setError((err as Error).message); }
  }

  const elegida: PiezaMovible | undefined = lote?.piezas.find((p) => p.id === piezaId);
  return (
    <section>
      <h2>Mover mercancía</h2>
      <p className="nota">1) Escanee el QR de la mercancía. 2) Elija la pieza que mueve. 3) Escanee la ubicación destino. La pieza se mueve completa.</p>
      <form onSubmit={buscar} className="formulario">
        <Campo etiqueta="1. QR de la mercancía (SKU + Lote)"><input value={mercancia} onChange={(e) => setMercancia(e.target.value)} placeholder="COL-M-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
        <Lector alLeer={(c) => { setMercancia(c); void buscar(undefined, c, origen); }} />
        <Campo etiqueta="Ubicación de origen (opcional: filtra las piezas)"><input value={origen} onChange={(e) => setOrigen(e.target.value)} placeholder="COL-U-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
        <button type="submit" disabled={!mercancia.trim()}>Ver piezas del lote</button>
      </form>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {ok && <Aviso tipo="ok">{ok}</Aviso>}

      {lote && (
        <article className="bloque">
          <h3>Lote {lote.lote.codigo} <small>{lote.lote.sku.referencia} · {lote.lote.sku.talla} · {lote.lote.sku.color}</small></h3>
          {lote.piezas.length === 0 && <p className="nota">No hay piezas con existencia{origen.trim() ? " en esa ubicación" : ""}.</p>}
          <div className="tabla-envoltura">
            <table>
              <thead><tr><th>Pieza</th><th>Tipo</th><th>Cantidad</th><th>Está en</th><th></th></tr></thead>
              <tbody>
                {lote.piezas.map((p) => (
                  <tr key={p.id + p.ubicacionId + p.estado} className={piezaId === p.id ? "fila-activa" : ""}>
                    <td>{PZ(p.numero)}</td><td>{p.tipo.toLowerCase()}</td><td>{p.cantidad}</td>
                    <td>{p.ubicacion} <Insignia tono={p.movible ? "ok" : "info"}>{p.estado === "DISPONIBLE" ? "disponible" : "en recepción"}</Insignia></td>
                    <td className="acciones">{p.movible ? <button className="secundario" onClick={() => { setPiezaId(p.id); setOk(""); }}>{piezaId === p.id ? "Elegida" : "Elegir"}</button> : <span className="nota">Se ubica desde la entrada</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}

      {elegida && (
        <form onSubmit={mover} className="formulario">
          <h3>Mover {PZ(elegida.numero)} ({elegida.cantidad}) desde {elegida.ubicacion}</h3>
          <Campo etiqueta="3. QR de la ubicación destino"><input value={destino} onChange={(e) => setDestino(e.target.value)} placeholder="COL-U-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
          <Lector alLeer={setDestino} />
          <Campo etiqueta="…o elija la ubicación (queda como identificación manual)">
            <select value={seleccion} onChange={(e) => setSeleccion(e.target.value)} disabled={!!destino.trim()}>
              <option value="">Elija una ubicación…</option>
              {destinos.map((u) => <option key={u.id} value={u.id}>{u.texto}</option>)}
            </select>
          </Campo>
          <button type="submit" disabled={!destino.trim() && !seleccion}>Confirmar movimiento</button>
        </form>
      )}
    </section>
  );
}
