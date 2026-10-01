import { useState, type FormEvent } from "react";
import type { EstadoSalida, LoteVista, MotivoVista, SalidaVista, SkuVista } from "@colbasoft/shared";
import { api, ErrorApi } from "../api";
import { Aviso, Campo, Insignia, Modal, fechaHora, useCarga } from "../ui";
import { Lector } from "./Lector";

const PZ = (n: number) => `P-${String(n).padStart(6, "0")}`;
const ESTADO: Record<EstadoSalida, { texto: string; tono: "ok" | "alerta" | "gris" | "info" }> = {
  SOLICITADA: { texto: "Solicitada", tono: "info" }, AUTORIZADA: { texto: "Autorizada · reservada", tono: "alerta" },
  CONFIRMADA: { texto: "Confirmada", tono: "ok" }, CANCELADA: { texto: "Cancelada", tono: "gris" }, VENCIDA: { texto: "Vencida · reserva liberada", tono: "gris" },
};
const nombreSku = (s: SkuVista) => `${s.referencia} · ${s.talla} · ${s.color}`;

interface Permisos { solicitar: boolean; autorizar: boolean; operar: boolean }

/** Salidas (HU-SAL-001 a HU-SAL-004, HU-SAL-008, HU-SAL-009): solicitar con motivo, autorizar (reserva), preparar escaneando y confirmar. */
export function Salidas({ permisos, usuario }: { permisos: Permisos; usuario: string }) {
  const [estado, setEstado] = useState("");
  const { datos, error, recargar } = useCarga(() => api.salidas(estado), [estado]);
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  return (
    <section>
      <div className="cabecera">
        <h2>Salidas</h2>
        {permisos.solicitar && <button onClick={() => setNueva(true)}>Nueva salida</button>}
      </div>
      <p className="nota">Toda salida lleva un motivo; no se pide cliente, precio ni factura. Al autorizarla, la existencia queda reservada hasta que se prepare y se confirme.</p>
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Filtrar por estado">
          <option value="">Todas</option>
          {(Object.keys(ESTADO) as EstadoSalida[]).map((e) => <option key={e} value={e}>{ESTADO[e].texto}</option>)}
        </select>
      </div>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {msg && <Aviso tipo="ok">{msg}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>N.º</th><th>Estado</th><th>Motivo</th><th>Líneas</th><th>Cantidad</th><th>Solicitó</th><th>Cuándo</th><th></th></tr></thead>
          <tbody>
            {(datos ?? []).map((s) => (
              <tr key={s.id}>
                <td>S-{s.numero}</td><td><Insignia tono={ESTADO[s.estado].tono}>{ESTADO[s.estado].texto}</Insignia>{s.parcial && <> <Insignia tono="alerta">parcial</Insignia></>}</td>
                <td>{s.motivo}</td><td>{s.lineas}</td><td>{s.cantidad}</td><td>{s.solicitadaPor}</td><td>{fechaHora(s.solicitadaEn)}</td>
                <td className="acciones"><button className="secundario" onClick={() => setAbierta(s.id)}>Abrir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {(datos ?? []).length === 0 && <p className="nota">No hay salidas.</p>}
      </div>
      {nueva && <NuevaSalida alCerrar={() => setNueva(false)} alCrear={(n) => { setNueva(false); setMsg(`Salida S-${n} solicitada: espera la autorización del Jefe.`); recargar(); }} />}
      {abierta && <DetalleSalida id={abierta} permisos={permisos} usuario={usuario} alCerrar={() => { setAbierta(null); recargar(); }} />}
    </section>
  );
}

function NuevaSalida({ alCerrar, alCrear }: { alCerrar: () => void; alCrear: (numero: number) => void }) {
  const motivos = useCarga<MotivoVista[]>(api.motivos);
  const skus = useCarga<SkuVista[]>(api.skus);
  const [motivoId, setMotivoId] = useState("");
  const [observacion, setObservacion] = useState("");
  const [lineas, setLineas] = useState([{ skuId: "", loteId: "", cantidad: "" }]);
  const [lotes, setLotes] = useState<Record<string, LoteVista[]>>({});
  const [error, setError] = useState("");
  const [parcial, setParcial] = useState<{ disponible: number } | null>(null);
  const opciones = (motivos.datos ?? []).filter((m) => m.tipoOperacion === "SALIDA" && m.activo);

  const cambiar = (i: number, c: Partial<(typeof lineas)[number]>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...c } : l)));
  async function elegirSku(i: number, skuId: string) {
    cambiar(i, { skuId, loteId: "" });
    if (skuId && !lotes[skuId]) setLotes({ ...lotes, [skuId]: await api.lotes({ skuId }) });
  }

  async function enviar(e: FormEvent, aceptarParcial = false) {
    e.preventDefault(); setError(""); setParcial(null);
    try {
      const s = await api.crearSalida({
        motivoId, ...(observacion.trim() ? { observacion: observacion.trim() } : {}), ...(aceptarParcial ? { aceptarParcial: true } : {}),
        lineas: lineas.map((l) => ({ skuId: l.skuId, ...(l.loteId ? { loteId: l.loteId } : {}), cantidad: Number(l.cantidad) })),
      });
      alCrear(s.numero);
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ErrorApi && err.cuerpo?.ofrecerParcial) setParcial({ disponible: Number(err.cuerpo.disponible) });
    }
  }

  return (
    <Modal titulo="Nueva salida" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="Motivo"><select value={motivoId} onChange={(e) => setMotivoId(e.target.value)}><option value="">— elija el motivo —</option>{opciones.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Observación (obligatoria si el motivo lo exige)"><input value={observacion} onChange={(e) => setObservacion(e.target.value)} maxLength={500} /></Campo>
        {lineas.map((l, i) => (
          <div key={i} className="rejilla">
            <Campo etiqueta={`Línea ${i + 1} · referencia, talla y color`}>
              <select value={l.skuId} onChange={(e) => void elegirSku(i, e.target.value)}><option value="">— elija —</option>{(skus.datos ?? []).map((s) => <option key={s.id} value={s.id}>{nombreSku(s)}</option>)}</select>
            </Campo>
            <Campo etiqueta="Lote (opcional)">
              <select value={l.loteId} onChange={(e) => cambiar(i, { loteId: e.target.value })} disabled={!l.skuId}><option value="">Cualquiera (según la política de toma)</option>{(lotes[l.skuId] ?? []).map((x) => <option key={x.id} value={x.id}>{x.codigo}</option>)}</select>
            </Campo>
            <Campo etiqueta="Cantidad"><input type="number" min="0" step="any" value={l.cantidad} onChange={(e) => cambiar(i, { cantidad: e.target.value })} /></Campo>
          </div>
        ))}
        <div className="acciones">
          <button type="button" className="secundario" onClick={() => setLineas([...lineas, { skuId: "", loteId: "", cantidad: "" }])}>Agregar línea</button>
          {lineas.length > 1 && <button type="button" className="secundario" onClick={() => setLineas(lineas.slice(0, -1))}>Quitar la última</button>}
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {parcial && <button type="button" className="secundario" onClick={(e) => void enviar(e, true)}>Registrar salida parcial por {parcial.disponible} (la autoriza el Jefe)</button>}
        <button type="submit" disabled={!motivoId || lineas.some((l) => !l.skuId || !(Number(l.cantidad) > 0))}>Solicitar salida</button>
      </form>
    </Modal>
  );
}

function DetalleSalida({ id, permisos, usuario, alCerrar }: { id: string; permisos: Permisos; usuario: string; alCerrar: () => void }) {
  const { datos: s, error: errorCarga, recargar } = useCarga<SalidaVista>(() => api.salida(id), [id]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [mercancia, setMercancia] = useState("");
  const [cantidades, setCantidades] = useState<Record<string, string>>({});

  async function accion(f: () => Promise<unknown>, mensaje: string) {
    setError(""); setOk("");
    try { await f(); setOk(mensaje); recargar(); } catch (e) { setError((e as Error).message); recargar(); }
  }
  async function tomar(piezaId: string) {
    setError(""); setOk("");
    const c = cantidades[piezaId]?.trim();
    try {
      const r = await api.tomarSalida(id, { mercanciaCodigo: mercancia.trim(), piezaId, ...(c ? { cantidad: Number(c) } : {}) });
      setOk(r.yaContada ? `${PZ(r.pieza)} ya estaba contada: no se suma otra vez.` : `${PZ(r.pieza)}: ${r.cantidad} tomadas${r.corte ? ` (corte parcial; le quedan ${r.restante})` : ""}.`);
      recargar();
    } catch (e) { setError((e as Error).message); }
  }

  if (!s) return <Modal titulo="Salida" alCerrar={alCerrar}>{errorCarga ? <Aviso tipo="error">{errorCarga}</Aviso> : <p>Cargando…</p>}</Modal>;
  const preparando = s.estado === "AUTORIZADA" && permisos.operar;
  const puedeCancelar = (s.estado === "SOLICITADA" || s.estado === "AUTORIZADA") && (permisos.autorizar || (permisos.solicitar && s.solicitadaPor === usuario));
  return (
    <Modal titulo={`Salida S-${s.numero}`} alCerrar={alCerrar}>
      <p><Insignia tono={ESTADO[s.estado].tono}>{ESTADO[s.estado].texto}</Insignia>{s.parcial && <> <Insignia tono="alerta">salida parcial</Insignia></>} · {s.motivo} · solicitó {s.solicitadaPor} ({fechaHora(s.solicitadaEn)})</p>
      {s.observacion && <p className="nota">Observación: {s.observacion}</p>}
      {s.autorizadaPor && <p className="nota">Autorizó {s.autorizadaPor} ({fechaHora(s.autorizadaEn!)}){s.venceEn && s.estado === "AUTORIZADA" ? ` · la reserva vence ${fechaHora(s.venceEn)}` : ""}.</p>}
      {s.estado === "VENCIDA" && <Aviso tipo="info">La reserva no se ejecutó a tiempo y se liberó sola. La existencia volvió a disponible.</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      {ok && <Aviso tipo="ok">{ok}</Aviso>}

      <h3>Lo que sale</h3>
      <div className="tabla-envoltura"><table>
        <thead><tr><th>Referencia</th><th>Lote</th><th>Sale</th>{s.parcial && <th>Pedido</th>}<th>Tomado</th></tr></thead>
        <tbody>{s.detalle.map((l) => <tr key={l.id}><td>{nombreSku(l.sku)}</td><td>{l.lote?.codigo ?? "según política"}</td><td>{l.cantidad}</td>{s.parcial && <td>{l.cantidadPedida}</td>}<td>{s.estado === "AUTORIZADA" || s.estado === "CONFIRMADA" ? `${l.tomada} de ${l.cantidad}` : "—"}</td></tr>)}</tbody>
      </table></div>

      {s.reservas.length > 0 && (
        <>
          <h3>{s.estado === "AUTORIZADA" ? "Piezas por tomar" : "Piezas reservadas"}</h3>
          {preparando && (
            <>
              <Campo etiqueta="QR de la mercancía que toma (SKU + Lote)"><input value={mercancia} onChange={(e) => setMercancia(e.target.value)} placeholder="COL-M-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
              <Lector alLeer={setMercancia} />
            </>
          )}
          <div className="tabla-envoltura"><table>
            <thead><tr><th>Pieza</th><th>Lote</th><th>Tomar de</th><th>Reservado</th><th>Tiene la pieza</th><th>Tomado</th><th></th></tr></thead>
            <tbody>
              {s.reservas.map((r) => (
                <tr key={r.id}>
                  <td>{PZ(r.pieza)}</td><td>{r.lote}</td><td>{r.ubicacion}</td><td>{r.cantidad}</td><td>{r.piezaTotal}{r.cantidad < r.piezaTotal && <> <Insignia tono="alerta">corte parcial</Insignia></>}</td>
                  <td>{r.tomada === null ? "—" : r.tomada}</td>
                  <td className="acciones">
                    {preparando && (r.tomada === null
                      ? <><input className="corto" type="number" min="0" step="any" placeholder={String(r.cantidad)} aria-label={`Cantidad a cortar de ${PZ(r.pieza)}`} value={cantidades[r.piezaId] ?? ""} onChange={(e) => setCantidades({ ...cantidades, [r.piezaId]: e.target.value })} /> <button className="secundario" disabled={!mercancia.trim()} onClick={() => void tomar(r.piezaId)}>Tomar</button></>
                      : <Insignia tono="ok">contada</Insignia>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      <div className="acciones">
        {s.estado === "SOLICITADA" && permisos.autorizar && <button onClick={() => void accion(() => api.autorizarSalida(id), "Salida autorizada: la existencia quedó reservada.")}>Autorizar y reservar</button>}
        {preparando && <button disabled={!s.completa && !s.parcial} onClick={() => void accion(() => api.confirmarSalida(id), "Salida confirmada: lo tomado salió del inventario y quedó en el kardex.")}>Confirmar salida</button>}
        {puedeCancelar && <button className="secundario" onClick={() => void accion(() => api.cancelarSalida(id), "Salida cancelada: la reserva volvió a disponible.")}>Cancelar salida</button>}
      </div>
      {preparando && !s.completa && !s.parcial && <p className="nota">Se confirma cuando todo lo pedido esté tomado. Una salida parcial autorizada se puede confirmar con lo tomado.</p>}
    </Modal>
  );
}
