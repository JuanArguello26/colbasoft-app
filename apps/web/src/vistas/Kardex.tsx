import { useEffect, useState } from "react";
import type { KardexVista, LoteVista, MotivoVista, PiezasDeLoteVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, Modal, fechaHora } from "../ui";
import { NOMBRE_ESTADO } from "./Existencia";

const NOMBRE_TIPO = { ENTRADA: "Entrada", MOVIMIENTO_INTERNO: "Movimiento interno", ANULACION: "Anulación", RESERVA: "Reserva", SALIDA: "Salida", LIBERACION: "Liberación de reserva" } as const;

/**
 * Kardex y trazabilidad (HU-KDX-001, HU-KDX-002, HU-KDX-006): las piezas de un lote y la historia de un lote o de una pieza.
 * No hay edición ni eliminación de movimientos; un error se neutraliza con una anulación (movimiento inverso, con motivo).
 */
export function Kardex({ loteInicial, puedeAnular, esAuxiliar }: { loteInicial: string | null; puedeAnular: boolean; esAuxiliar: boolean }) {
  const [filtro, setFiltro] = useState("");
  const [lotes, setLotes] = useState<LoteVista[]>([]);
  const [loteId, setLoteId] = useState(loteInicial ?? "");
  const [piezas, setPiezas] = useState<PiezasDeLoteVista | null>(null);
  const [piezaId, setPiezaId] = useState("");
  const [kardex, setKardex] = useState<KardexVista | null>(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [anulando, setAnulando] = useState<{ id: string; secuencia: number } | null>(null);
  const [refrescar, setRefrescar] = useState(0);

  useEffect(() => { api.lotes({ q: filtro }).then(setLotes).catch((e: Error) => setError(e.message)); }, [filtro]);
  useEffect(() => { setPiezaId(""); }, [loteId]);
  useEffect(() => {
    if (!loteId) { setPiezas(null); setKardex(null); return; }
    setError("");
    api.piezasDeLote(loteId).then(setPiezas).catch((e: Error) => setError(e.message));
  }, [loteId, refrescar]);
  const consulta: Record<string, string> = piezaId ? { piezaId } : { loteId };
  useEffect(() => {
    if (!loteId) return;
    api.kardex(consulta).then(setKardex).catch((e: Error) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loteId, piezaId, refrescar]);

  return (
    <section>
      <h2>Kardex y trazabilidad</h2>
      <p className="nota">Cada movimiento queda para siempre: no se edita ni se borra. {esAuxiliar && "Usted ve solo lo que movió en los últimos 30 días."}</p>
      <div className="rejilla">
        <Campo etiqueta="Buscar lote"><input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Lote, origen o referencia" /></Campo>
        <Campo etiqueta="Lote">
          <select value={loteId} onChange={(e) => setLoteId(e.target.value)}>
            <option value="">— elija un lote —</option>
            {lotes.map((l) => <option key={l.id} value={l.id}>{l.codigo} · {l.sku.referencia} {l.sku.talla} {l.sku.color}</option>)}
            {loteInicial && !lotes.some((l) => l.id === loteInicial) && <option value={loteInicial}>Lote elegido</option>}
          </select>
        </Campo>
      </div>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      {piezas && (
        <article className="bloque">
          <h3>Piezas del lote {piezas.lote.codigo} <small>{piezas.lote.sku.referencia} · {piezas.lote.sku.talla} · {piezas.lote.sku.color}</small></h3>
          <div className="tabla-envoltura">
            <table>
              <thead><tr><th>Pieza</th><th>Tipo</th><th>Recibida</th><th>Actual</th><th>Ubicación y estado</th><th></th></tr></thead>
              <tbody>
                {piezas.piezas.map((p) => (
                  <tr key={p.id} className={piezaId === p.id ? "fila-activa" : ""}>
                    <td>P-{String(p.numero).padStart(6, "0")}</td><td>{p.tipo.toLowerCase()}</td><td>{p.cantidad}</td><td><strong>{p.cantidadActual}</strong></td>
                    <td>{p.ubicaciones.length === 0 ? <span className="nota">sin existencia</span> : p.ubicaciones.map((u) => <span key={u.ubicacionId + u.estado}>{u.ubicacion} · {u.cantidad} <Insignia tono={u.estado === "DISPONIBLE" ? "ok" : "info"}>{NOMBRE_ESTADO[u.estado].toLowerCase()}</Insignia> </span>)}</td>
                    <td className="acciones"><button className="secundario" onClick={() => setPiezaId(piezaId === p.id ? "" : p.id)}>{piezaId === p.id ? "Ver todo el lote" : "Kardex de la pieza"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {piezas.piezas.length === 0 && <p className="nota">Este lote aún no tiene piezas.</p>}
        </article>
      )}

      {kardex && (
        <article className="bloque">
          <div className="cabecera">
            <h3>Movimientos {piezaId ? "de la pieza" : "del lote"}</h3>
            <div className="acciones">
              <Insignia tono={kardex.continuidad.ok ? "ok" : "alerta"}>{kardex.restringido ? "Vista restringida" : kardex.continuidad.ok ? "Sin huecos" : "Discontinuidad"}</Insignia>
              <a className="boton" href={api.urlKardexCsv(consulta)}>Exportar CSV</a>
            </div>
          </div>
          {kardex.truncado && <Aviso tipo="info">Se muestran los primeros movimientos; use la exportación o acote la consulta.</Aviso>}
          <div className="tabla-envoltura">
            <table>
              <thead><tr><th>N.º</th><th>Fecha y hora</th><th>Tipo</th><th>Cantidad</th><th>Existencia</th><th>Pieza</th><th>Ubicación</th><th>Estado</th><th>Usuario</th><th>Documento</th><th>Motivo</th><th></th></tr></thead>
              <tbody>
                {kardex.lineas.map((l, i) => (
                  <tr key={`${l.movimientoId}${i}`}>
                    <td>{l.secuencia}</td><td>{fechaHora(l.instante)}</td>
                    <td>{NOMBRE_TIPO[l.tipo]}{l.anulaA !== null && <small> de #{l.anulaA}</small>}{l.anuladoPor !== null && <> <Insignia tono="alerta">anulado por #{l.anuladoPor}</Insignia></>}</td>
                    <td>{l.cantidad > 0 ? `+${l.cantidad}` : l.cantidad}</td><td><strong>{l.existenciaResultante}</strong></td>
                    <td>P-{String(l.pieza).padStart(6, "0")}</td><td>{l.ubicacion}</td><td>{NOMBRE_ESTADO[l.estado]}</td><td>{l.usuario}</td><td>{l.documento ?? (l.salida !== null ? `S-${l.salida}` : "—")}</td><td>{l.motivo ?? "—"}</td>
                    <td className="acciones">{puedeAnular && (l.tipo === "ENTRADA" || l.tipo === "MOVIMIENTO_INTERNO") && l.anuladoPor === null && <button className="secundario" onClick={() => setAnulando({ id: l.movimientoId, secuencia: l.secuencia })}>Anular</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kardex.lineas.length === 0 && <p className="nota">No hay movimientos para mostrar.</p>}
          <p className="nota">Existencia = suma acumulada de las cantidades. Final: <strong>{kardex.existenciaFinal}</strong>.</p>
        </article>
      )}

      {anulando && <Anular movimiento={anulando} alCerrar={() => setAnulando(null)} alAnular={(m) => { setAnulando(null); setAviso(m); setRefrescar((n) => n + 1); }} />}
    </section>
  );
}

function Anular({ movimiento, alCerrar, alAnular }: { movimiento: { id: string; secuencia: number }; alCerrar: () => void; alAnular: (mensaje: string) => void }) {
  const [motivos, setMotivos] = useState<MotivoVista[]>([]);
  const [motivoId, setMotivoId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.motivos().then((m) => setMotivos(m.filter((x) => x.tipoOperacion === "ANULACION" && x.activo))).catch((e: Error) => setError(e.message)); }, []);

  async function confirmar() {
    setError("");
    try { const r = await api.anularMovimiento(movimiento.id, motivoId); alAnular(`Movimiento ${r.anulado} anulado con el movimiento inverso ${r.inverso}. Ambos quedan en el kardex.`); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <Modal titulo={`Anular el movimiento ${movimiento.secuencia}`} alCerrar={alCerrar}>
      <p>No se borra nada: se registra un movimiento inverso y ambos quedan visibles. Quedará en la bitácora.</p>
      <Campo etiqueta="Motivo"><select value={motivoId} onChange={(e) => setMotivoId(e.target.value)}><option value="">— elija el motivo —</option>{motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></Campo>
      {error && <Aviso tipo="error">{error}</Aviso>}
      <button onClick={confirmar} disabled={!motivoId}>Anular movimiento</button>
    </Modal>
  );
}
