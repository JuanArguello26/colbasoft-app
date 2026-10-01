import { useState, type FormEvent } from "react";
import { TIPOS_PIEZA_POR_UNIDAD, type DocumentoEntradaResumen, type DocumentoEntradaVista, type EstadoDocumentoEntrada, type LineaEntradaVista, type PiezaVista, type PropuestaUbicacion, type ResultadoLinea, type SkuVista, type TipoPieza } from "@colbasoft/shared";
import { api, ErrorApi } from "../api";
import { Aviso, Campo, Insignia, Modal, fechaHora, useCarga } from "../ui";
import { Lector } from "./Lector";

const ESTADO: Record<EstadoDocumentoEntrada, { nombre: string; tono: "ok" | "alerta" | "gris" | "info" }> = {
  PENDIENTE_RECEPCION: { nombre: "Pendiente de recepción", tono: "gris" },
  RECEPCION_PARCIAL: { nombre: "Recepción parcial", tono: "info" },
  RECIBIDO_CONFORME: { nombre: "Recibido conforme", tono: "ok" },
  RECIBIDO_CON_NOVEDAD: { nombre: "Recibido con novedad", tono: "alerta" },
  CONFIRMADO: { nombre: "Confirmado", tono: "ok" },
};
const RESULTADO: Record<ResultadoLinea, { nombre: string; tono: "ok" | "alerta" | "gris" | "info" }> = {
  SIN_RECIBIR: { nombre: "Sin recibir", tono: "gris" },
  EN_CURSO: { nombre: "En curso", tono: "info" },
  CONFORME: { nombre: "Conforme", tono: "ok" },
  FALTANTE: { nombre: "Faltante", tono: "alerta" },
  SOBRANTE: { nombre: "Sobrante", tono: "alerta" },
};
const NOMBRE_PIEZA: Record<TipoPieza, string> = { ROLLO: "Rollo", PAQUETE: "Paquete", BOLSA: "Bolsa" };
const ENT = (n: number) => `ENT-${String(n).padStart(4, "0")}`;
const PZ = (n: number) => `P-${String(n).padStart(6, "0")}`;
const nombreSku = (s: SkuVista) => `${s.referencia} · ${s.descripcion} · ${s.talla} · ${s.color}`;
const unidad = (s: SkuVista) => s.unidadMedida.toLowerCase();

export interface PermisosEntradas { crear: boolean; recibir: boolean; confirmar: boolean; autorizar: boolean; verDesviaciones: boolean }

export function Entradas({ permisos }: { permisos: PermisosEntradas }) {
  const [estado, setEstado] = useState("");
  const { datos, error, recargar } = useCarga(() => api.entradas(estado || undefined), [estado]);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [nueva, setNueva] = useState(false);
  const [desv, setDesv] = useState(false);

  if (abierto) return <Detalle id={abierto} permisos={permisos} alVolver={() => { setAbierto(null); recargar(); }} />;
  return (
    <section>
      <div className="cabecera">
        <h2>Entradas</h2>
        <span className="acciones">
          {permisos.verDesviaciones && <button className="secundario" onClick={() => setDesv(true)}>Desviaciones de ubicación</button>}
          {permisos.crear && <button onClick={() => setNueva(true)}>Nueva entrada</button>}
        </span>
      </div>
      <p className="nota">El documento de entrada es lo que se espera recibir; no es una orden de compra. La mercancía se recibe por piezas y solo cuenta en el inventario cuando otra persona confirma la entrada.</p>
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          {(Object.keys(ESTADO) as EstadoDocumentoEntrada[]).map((e) => <option key={e} value={e}>{ESTADO[e].nombre}</option>)}
        </select>
      </div>
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>Entrada</th><th>Origen</th><th>Esperada</th><th className="num">Líneas</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {(datos ?? []).map((d) => <Fila key={d.id} d={d} abrir={() => setAbierto(d.id)} />)}
          </tbody>
        </table>
        {(datos ?? []).length === 0 && <p className="nota">No hay documentos de entrada.</p>}
      </div>
      {nueva && <FormEntrada alCerrar={() => setNueva(false)} alGuardar={(id) => { setNueva(false); setAbierto(id); }} />}
      {desv && <Desviaciones alCerrar={() => setDesv(false)} />}
    </section>
  );
}

function Fila({ d, abrir }: { d: DocumentoEntradaResumen; abrir: () => void }) {
  return (
    <tr>
      <td><strong>{ENT(d.numero)}</strong></td><td>{d.origen}</td><td>{d.fechaEsperada}</td><td className="num">{d.lineas}</td>
      <td><Insignia tono={ESTADO[d.estado].tono}>{ESTADO[d.estado].nombre}</Insignia> {d.tieneFaltante && <Insignia tono="alerta">Faltante</Insignia>} {d.tieneSobrante && <Insignia tono="alerta">Sobrante</Insignia>}</td>
      <td className="acciones"><button className="secundario" onClick={abrir}>Abrir</button></td>
    </tr>
  );
}

function Detalle({ id, permisos, alVolver }: { id: string; permisos: PermisosEntradas; alVolver: () => void }) {
  const { datos: d, error, recargar } = useCarga(() => api.entrada(id), [id]);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ubicando, setUbicando] = useState<PiezaVista | null>(null);

  async function correr(f: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await f(); setMsg({ tipo: "ok", texto: ok }); recargar(); } catch (e) { setMsg({ tipo: "error", texto: (e as Error).message }); }
  }
  if (!d) return <section>{error ? <Aviso tipo="error">{error}</Aviso> : <p>Cargando…</p>}<button className="secundario" onClick={alVolver}>Volver</button></section>;

  const abierta = d.estado === "PENDIENTE_RECEPCION" || d.estado === "RECEPCION_PARCIAL";
  const cerrada = d.estado === "RECIBIDO_CONFORME" || d.estado === "RECIBIDO_CON_NOVEDAD";
  const sobrantePendiente = d.estado === "RECIBIDO_CON_NOVEDAD" && d.tieneSobrante && !d.sobranteAutorizado;

  return (
    <section>
      <div className="cabecera">
        <h2>{ENT(d.numero)} <Insignia tono={ESTADO[d.estado].tono}>{ESTADO[d.estado].nombre}</Insignia></h2>
        <button className="secundario" onClick={alVolver}>Volver</button>
      </div>
      <p className="nota">Origen: <strong>{d.origen}</strong> · esperada {d.fechaEsperada} · bodega {d.bodega} · creada por {d.creadoPor}
        {d.llegadaEn && <> · llegó {fechaHora(d.llegadaEn)}</>}
        {d.receptores.length > 0 && <> · recibió {d.receptores.join(" y ")}</>}
        {d.confirmado && <> · confirmó {d.confirmado.por} ({fechaHora(d.confirmado.en)}); la existencia quedó en recepción en {d.ubicacionRecepcion}</>}
        {d.sobranteAutorizado && <> · sobrante autorizado por {d.sobranteAutorizado.por}</>}</p>
      {msg && <Aviso tipo={msg.tipo}>{msg.texto}</Aviso>}
      {sobrantePendiente && <Aviso tipo="info">Hay sobrante: el Jefe de Bodega debe autorizarlo antes de confirmar la entrada. Un sobrante no autorizado no ingresa al inventario.</Aviso>}
      {d.tieneFaltante && cerrada && <Aviso tipo="info">Hay faltante de recepción. Queda registrado en el documento y en la bitácora; no impide confirmar lo recibido.</Aviso>}

      {d.detalle.map((l) => (
        <Linea key={l.id} l={l} d={d} puedeRecibir={permisos.recibir && abierta} puedeUbicar={permisos.recibir && d.estado === "CONFIRMADO"}
          alRegistrar={(tipo, cantidad) => correr(() => api.registrarPieza(d.id, { lineaId: l.id, tipo, cantidad }), `Pieza guardada: ${NOMBRE_PIEZA[tipo].toLowerCase()} de ${cantidad} ${unidad(l.sku)} en ${l.sku.referencia}.`)}
          alUbicar={setUbicando} />
      ))}

      <div className="acciones">
        {permisos.recibir && abierta && <button className="secundario" onClick={() => correr(() => api.cerrarRecepcion(d.id), "Recepción cerrada: la diferencia quedó registrada en el documento.")}>Cerrar recepción</button>}
        {permisos.autorizar && sobrantePendiente && <button onClick={() => correr(() => api.autorizarSobrante(d.id), "Sobrante autorizado.")}>Autorizar sobrante</button>}
        {permisos.confirmar && cerrada && <button onClick={() => setConfirmando(true)}>Confirmar entrada</button>}
      </div>
      {confirmando && <FormConfirmar d={d} alCerrar={() => setConfirmando(false)} alGuardar={() => { setConfirmando(false); setMsg({ tipo: "ok", texto: "Entrada confirmada: la mercancía quedó en recepción, pendiente de ubicar." }); recargar(); }} />}
      {ubicando && <FormUbicar pieza={ubicando} alCerrar={() => setUbicando(null)} alGuardar={(texto) => { setUbicando(null); setMsg({ tipo: "ok", texto }); recargar(); }} />}
    </section>
  );
}

function Linea({ l, d, puedeRecibir, puedeUbicar, alRegistrar, alUbicar }: { l: LineaEntradaVista; d: DocumentoEntradaVista; puedeRecibir: boolean; puedeUbicar: boolean; alRegistrar: (t: TipoPieza, c: number) => Promise<void>; alUbicar: (p: PiezaVista) => void }) {
  const tipos = TIPOS_PIEZA_POR_UNIDAD[l.sku.unidadMedida];
  const [tipo, setTipo] = useState<TipoPieza>(tipos[0]!);
  const [cantidad, setCantidad] = useState("");
  const [enviando, setEnviando] = useState(false);
  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try { await alRegistrar(tipo, Number(cantidad.replace(",", "."))); setCantidad(""); } finally { setEnviando(false); }
  }
  return (
    <article className="bloque">
      <div className="cabecera">
        <h3>{nombreSku(l.sku)}</h3>
        <Insignia tono={RESULTADO[l.resultado].tono}>{RESULTADO[l.resultado].nombre}</Insignia>
      </div>
      <p>Esperado <strong>{l.cantidadEsperada}</strong> · recibido <strong>{l.cantidadRecibida}</strong> {unidad(l.sku)}
        {l.diferencia !== null && l.diferencia !== 0 && <> · diferencia <strong>{l.diferencia > 0 ? "+" : ""}{l.diferencia}</strong></>}
        {l.lote && <> · lote <strong>{l.lote.codigo}</strong></>}</p>
      {l.piezas.length > 0 && (
        <ul className="lista">
          {l.piezas.map((p) => (
            <li key={p.id}>
              <span><strong>{PZ(p.numero)}</strong> · {NOMBRE_PIEZA[p.tipo]} de {p.cantidad} {unidad(l.sku)} <small>registró {p.registradaPor}</small></span>
              <span className="acciones">
                {p.ubicaciones.map((u) => <Insignia key={u.ubicacionId + u.estado} tono={u.estado === "DISPONIBLE" ? "ok" : "alerta"}>{u.ubicacion} · {u.estado === "DISPONIBLE" ? "disponible" : "en recepción"}</Insignia>)}
                {puedeUbicar && p.ubicaciones.some((u) => u.estado === "EN_RECEPCION") && <button className="secundario" onClick={() => alUbicar(p)}>Ubicar</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {puedeRecibir && (
        <form onSubmit={enviar} className="rejilla">
          <Campo etiqueta="Tipo de pieza">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoPieza)}>{tipos.map((t) => <option key={t} value={t}>{NOMBRE_PIEZA[t]}</option>)}</select>
          </Campo>
          <Campo etiqueta={`Cantidad de la pieza (${unidad(l.sku)})`}><input inputMode="decimal" value={cantidad} onChange={(e) => setCantidad(e.target.value)} /></Campo>
          <button type="submit" disabled={enviando || !cantidad.trim() || Number.isNaN(Number(cantidad.replace(",", ".")))}>Guardar pieza</button>
        </form>
      )}
      {d.estado === "CONFIRMADO" && l.piezas.length === 0 && <p className="nota">Sin piezas recibidas.</p>}
    </article>
  );
}

function FormEntrada({ alCerrar, alGuardar }: { alCerrar: () => void; alGuardar: (id: string) => void }) {
  const skus = useCarga(api.skus);
  const bodegas = useCarga(api.bodegas);
  const [bodegaId, setBodegaId] = useState("");
  const [origen, setOrigen] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [lineas, setLineas] = useState<Array<{ skuId: string; cantidad: string }>>([{ skuId: "", cantidad: "" }]);
  const [error, setError] = useState("");
  const [duplicados, setDuplicados] = useState<Array<{ numero: number }> | null>(null);
  const bodega = bodegaId || bodegas.datos?.[0]?.id || "";

  async function enviar(e: FormEvent, confirmarDuplicado = false) {
    e.preventDefault(); setError("");
    try {
      const d = await api.crearEntrada({ bodegaId: bodega, origen, fechaEsperada: fecha, confirmarDuplicado, lineas: lineas.map((l) => ({ skuId: l.skuId, cantidad: Number(l.cantidad.replace(",", ".")) })) });
      alGuardar(d.id);
    } catch (err) {
      // RN-ENT-002: se advierte del posible duplicado y se exige confirmación explícita.
      if (err instanceof ErrorApi && err.codigo === "POSIBLE_DUPLICADO") setDuplicados((err.cuerpo?.duplicados as Array<{ numero: number }>) ?? []);
      else setError((err as Error).message);
    }
  }
  const poner = (i: number, c: Partial<{ skuId: string; cantidad: string }>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...c } : l)));
  const completo = !!bodega && origen.trim().length >= 2 && lineas.every((l) => l.skuId && l.cantidad.trim() && !Number.isNaN(Number(l.cantidad.replace(",", "."))));

  return (
    <Modal titulo="Nueva entrada" alCerrar={alCerrar}>
      <form onSubmit={(e) => enviar(e)} className="formulario">
        {(bodegas.datos?.length ?? 0) > 1 && (
          <Campo etiqueta="Bodega"><select value={bodega} onChange={(e) => setBodegaId(e.target.value)}>{bodegas.datos!.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select></Campo>
        )}
        <Campo etiqueta="Origen (proveedor o procedencia)"><input value={origen} onChange={(e) => setOrigen(e.target.value)} maxLength={120} /></Campo>
        <Campo etiqueta="Fecha esperada"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
        <fieldset>
          <legend>Lo que se espera recibir</legend>
          {lineas.map((l, i) => (
            <div key={i} className="rejilla">
              <Campo etiqueta="SKU">
                <select value={l.skuId} onChange={(e) => poner(i, { skuId: e.target.value })}>
                  <option value="">Elija un SKU…</option>
                  {(skus.datos ?? []).map((s) => <option key={s.id} value={s.id}>{nombreSku(s)} ({unidad(s)})</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Cantidad esperada"><input inputMode="decimal" value={l.cantidad} onChange={(e) => poner(i, { cantidad: e.target.value })} /></Campo>
              {lineas.length > 1 && <button type="button" className="secundario" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>Quitar</button>}
            </div>
          ))}
          <button type="button" className="secundario" onClick={() => setLineas((ls) => [...ls, { skuId: "", cantidad: "" }])}>+ Línea</button>
        </fieldset>
        <p className="nota">Solo lo que se espera recibir: el documento no pide precio, condiciones comerciales ni orden de compra.</p>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {duplicados && (
          <Aviso tipo="info">
            Ya existe {duplicados.length === 1 ? "un documento" : "documentos"} con el mismo origen, referencia y fecha ({duplicados.map((x) => ENT(x.numero)).join(", ")}). Puede ser otra remesa legítima.
            <button type="button" className="secundario" onClick={(e) => enviar(e, true)}>Sí, es otra remesa: crear</button>
          </Aviso>
        )}
        <button type="submit" disabled={!completo}>Crear entrada</button>
      </form>
    </Modal>
  );
}

function FormConfirmar({ d, alCerrar, alGuardar }: { d: DocumentoEntradaVista; alCerrar: () => void; alGuardar: () => void }) {
  const conPiezas = d.detalle.filter((l) => l.piezas.length > 0);
  const [codigos, setCodigos] = useState<Record<string, string>>({});
  const [origenes, setOrigenes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  async function enviar(e: FormEvent) {
    e.preventDefault(); setError("");
    try { await api.confirmarEntrada(d.id, conPiezas.map((l) => ({ lineaId: l.id, codigo: codigos[l.id]!, ...(origenes[l.id]?.trim() ? { origen: origenes[l.id]!.trim() } : {}) }))); alGuardar(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <Modal titulo={`Confirmar ${ENT(d.numero)}`} alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        <p className="nota">Quien registró la recepción no puede confirmarla. Al confirmar se crea el movimiento de entrada en el kardex y la mercancía queda <strong>en recepción</strong> (no disponible) hasta ubicarse. Si el código ya existe para ese SKU, se asocia a ese lote.</p>
        {conPiezas.map((l) => (
          <fieldset key={l.id}>
            <legend>{nombreSku(l.sku)} · {l.cantidadRecibida} {unidad(l.sku)}</legend>
            <div className="rejilla">
              <Campo etiqueta="Código del lote"><input value={codigos[l.id] ?? ""} onChange={(e) => setCodigos({ ...codigos, [l.id]: e.target.value })} maxLength={40} /></Campo>
              <Campo etiqueta="Origen del lote (opcional)"><input value={origenes[l.id] ?? ""} placeholder={d.origen} onChange={(e) => setOrigenes({ ...origenes, [l.id]: e.target.value })} maxLength={120} /></Campo>
            </div>
          </fieldset>
        ))}
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={conPiezas.some((l) => !codigos[l.id]?.trim())}>Confirmar entrada</button>
      </form>
    </Modal>
  );
}

function FormUbicar({ pieza, alCerrar, alGuardar }: { pieza: PiezaVista; alCerrar: () => void; alGuardar: (texto: string) => void }) {
  const propuesta = useCarga<PropuestaUbicacion>(() => api.propuesta(pieza.id), [pieza.id]);
  const bodegas = useCarga(api.bodegas);
  const [mercancia, setMercancia] = useState("");
  const [destino, setDestino] = useState("");
  const [seleccion, setSeleccion] = useState("");
  const [error, setError] = useState("");
  const elegibles = (bodegas.datos ?? []).flatMap((b) => b.zonas.filter((z) => z.tipo !== "CUARENTENA").flatMap((z) => z.ubicaciones.filter((u) => u.activa).map((u) => ({ id: u.id, texto: `${u.codigo} · ${z.nombre}` }))));

  async function enviar(e: FormEvent) {
    e.preventDefault(); setError("");
    try {
      const r = await api.ubicarPieza(pieza.id, { ...(mercancia.trim() ? { mercanciaCodigo: mercancia.trim() } : {}), ...(destino.trim() ? { destinoCodigo: destino.trim() } : { destinoId: seleccion }) });
      alGuardar(`${PZ(pieza.numero)} ubicada en ${r.destino} (${r.estado === "DISPONIBLE" ? "disponible" : "sigue en recepción"}).${r.desviacion ? " Es distinta a la propuesta: quedó registrada como información operativa y se avisa al Coordinador." : ""}`);
    } catch (err) { setError((err as Error).message); }
  }
  const p = propuesta.datos;
  return (
    <Modal titulo={`Ubicar ${PZ(pieza.numero)}`} alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        {propuesta.error && <Aviso tipo="error">{propuesta.error}</Aviso>}
        {p && <Aviso tipo="info">Se propone <strong>{p.ubicacion.codigo}</strong> (zona {p.ubicacion.zona}). {p.explicacion} Puede elegir otra: se permite y queda registrado.</Aviso>}
        <Campo etiqueta="1. QR de la mercancía (SKU + Lote)"><input value={mercancia} onChange={(e) => setMercancia(e.target.value)} placeholder="COL-M-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
        <Lector alLeer={setMercancia} />
        <Campo etiqueta="2. QR de la ubicación destino"><input value={destino} onChange={(e) => setDestino(e.target.value)} placeholder="COL-U-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
        <Lector alLeer={setDestino} />
        <Campo etiqueta="…o elija la ubicación (queda como identificación manual)">
          <select value={seleccion} onChange={(e) => setSeleccion(e.target.value)} disabled={!!destino.trim()}>
            <option value="">Elija una ubicación…</option>
            {elegibles.map((u) => <option key={u.id} value={u.id}>{u.texto}</option>)}
          </select>
        </Campo>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={!destino.trim() && !seleccion}>Confirmar ubicación</button>
      </form>
    </Modal>
  );
}

function Desviaciones({ alCerrar }: { alCerrar: () => void }) {
  const { datos, error } = useCarga(api.desviaciones);
  return (
    <Modal titulo="Desviaciones de ubicación" alCerrar={alCerrar}>
      <p className="nota">Cuando se ubica en un lugar distinto al propuesto se permite y se registra. Es información operativa para mejorar la propuesta, no una falta de quien ubicó.</p>
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>Cuándo</th><th>Entrada</th><th>Pieza</th><th>Propuesta</th><th>Elegida</th><th>Quién</th></tr></thead>
          <tbody>{(datos ?? []).map((x) => <tr key={x.movimientoId}><td>{fechaHora(x.instante)}</td><td>{ENT(x.documento)}</td><td>{PZ(x.pieza)}</td><td>{x.propuesta ?? "—"}</td><td>{x.elegida}</td><td>{x.usuario}</td></tr>)}</tbody>
        </table>
        {(datos ?? []).length === 0 && <p className="nota">No hay desviaciones registradas.</p>}
      </div>
    </Modal>
  );
}
