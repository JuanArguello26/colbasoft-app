import { useState, type FormEvent } from "react";
import { UNIDADES_MEDIDA, type ReferenciaDetalle, type ReferenciaResumen, type UnidadMedida } from "@colbasoft/shared";
import { api, type Conjunto } from "../api";
import { Aviso, Campo, Insignia, Modal, useCarga } from "../ui";

export function Catalogo({ puedeEditar }: { puedeEditar: boolean }) {
  const { datos, error, recargar } = useCarga(api.referencias);
  const [filtro, setFiltro] = useState("");
  const [soloActivas, setSoloActivas] = useState(false);
  const [nueva, setNueva] = useState(false);
  const [editando, setEditando] = useState<ReferenciaResumen | null>(null);
  const [detalle, setDetalle] = useState<ReferenciaDetalle | null>(null);
  const [msg, setMsg] = useState("");

  const visibles = (datos ?? []).filter((r) => (!soloActivas || r.activa) && `${r.codigo} ${r.descripcion} ${r.categoria}`.toLowerCase().includes(filtro.toLowerCase()));

  async function alternar(r: ReferenciaResumen) {
    setMsg("");
    try { await api.referenciaAccion(r.id, r.activa ? "desactivar" : "reactivar"); recargar(); } catch (e) { setMsg((e as Error).message); }
  }
  async function ver(r: ReferenciaResumen) {
    try { setDetalle(await api.referencia(r.id)); } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <section>
      <div className="cabecera">
        <h2>Catálogo de referencias</h2>
        {puedeEditar && <button onClick={() => setNueva(true)}>Nueva referencia</button>}
      </div>
      <div className="acciones">
        <input className="buscar" placeholder="Buscar por código, descripción o categoría" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        <label className="casilla"><input type="checkbox" checked={soloActivas} onChange={(e) => setSoloActivas(e.target.checked)} /> Solo activas</label>
      </div>
      {msg && <Aviso tipo="error">{msg}</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>Código</th><th>Descripción</th><th>Categoría</th><th>Unidad</th><th className="num">SKU</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {visibles.map((r) => (
              <tr key={r.id} className={r.activa ? "" : "apagado"}>
                <td><strong>{r.codigo}</strong></td><td>{r.descripcion}</td><td>{r.categoria}</td><td>{r.unidadMedida.toLowerCase()}</td>
                <td className="num">{r.skus}</td>
                <td>{r.activa ? <Insignia tono="ok">Activa</Insignia> : <Insignia>Inactiva</Insignia>}</td>
                <td className="acciones">
                  <button className="secundario" onClick={() => ver(r)}>Ver</button>
                  {puedeEditar && <button className="secundario" onClick={() => setEditando(r)}>Editar</button>}
                  {puedeEditar && <button className="secundario" onClick={() => alternar(r)}>{r.activa ? "Desactivar" : "Reactivar"}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="nota">{visibles.length} de {(datos ?? []).length} referencias. Una referencia no se elimina: se desactiva.</p>
      </div>
      {nueva && <FormReferencia alCerrar={() => setNueva(false)} alGuardar={() => { setNueva(false); recargar(); }} />}
      {editando && <FormEdicion ref_={editando} alCerrar={() => setEditando(null)} alGuardar={() => { setEditando(null); recargar(); }} />}
      {detalle && (
        <Modal titulo={`${detalle.codigo} · ${detalle.descripcion}`} alCerrar={() => setDetalle(null)}>
          <p><strong>Categoría:</strong> {detalle.categoria} · <strong>Unidad:</strong> {detalle.unidadMedida.toLowerCase()} · <strong>SKU generados:</strong> {detalle.skus}</p>
          <p><strong>Tallas:</strong> {detalle.tallas.join(", ")}</p>
          <p><strong>Colores:</strong> {detalle.colores.join(", ")}</p>
        </Modal>
      )}
    </section>
  );
}

function FormReferencia({ alCerrar, alGuardar }: { alCerrar: () => void; alGuardar: () => void }) {
  const cats = useCarga(() => api.conjunto("categorias"));
  const tallas = useCarga(() => api.conjunto("tallas"));
  const colores = useCarga(() => api.conjunto("colores"));
  const [codigo, setCodigo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [unidad, setUnidad] = useState<UnidadMedida>("UNIDADES");
  const [tallaIds, setTallaIds] = useState<string[]>([]);
  const [colorIds, setColorIds] = useState<string[]>([]);
  const [error, setError] = useState("");

  const alternar = (lista: string[], set: (v: string[]) => void, id: string) => set(lista.includes(id) ? lista.filter((x) => x !== id) : [...lista, id]);

  async function agregar(tipo: "categorias" | "tallas" | "colores") {
    const n = window.prompt(`Nuevo valor para ${tipo}`)?.trim();
    if (!n) return;
    try { await api.crearConjunto(tipo, n); (tipo === "categorias" ? cats : tipo === "tallas" ? tallas : colores).recargar(); } catch (e) { setError((e as Error).message); }
  }
  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await api.crearReferencia({ codigo, descripcion, categoriaId, unidadMedida: unidad, tallaIds, colorIds }); alGuardar(); }
    catch (err) { setError((err as Error).message); }
  }

  const grupo = (titulo: string, datos: Conjunto[] | null, marcados: string[], set: (v: string[]) => void, tipo: "tallas" | "colores") => (
    <fieldset><legend>{titulo}</legend>
      <div className="chips">{(datos ?? []).map((t) => <label key={t.id} className={`chip ${marcados.includes(t.id) ? "on" : ""}`}><input type="checkbox" checked={marcados.includes(t.id)} onChange={() => alternar(marcados, set, t.id)} />{t.nombre}</label>)}</div>
      <button type="button" className="enlace" onClick={() => agregar(tipo)}>+ Agregar {titulo.toLowerCase()} al conjunto</button>
    </fieldset>
  );

  return (
    <Modal titulo="Nueva referencia" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="Código (único)"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} /></Campo>
        <Campo etiqueta="Descripción"><input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} /></Campo>
        <Campo etiqueta="Categoría">
          <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}><option value="">Seleccione…</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
        </Campo>
        <Campo etiqueta="Unidad de medida">
          <select value={unidad} onChange={(e) => setUnidad(e.target.value as UnidadMedida)}>{UNIDADES_MEDIDA.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}</select>
        </Campo>
        {grupo("Tallas", tallas.datos, tallaIds, setTallaIds, "tallas")}
        {grupo("Colores", colores.datos, colorIds, setColorIds, "colores")}
        <p className="nota">Se generará un SKU por cada combinación: {tallaIds.length * colorIds.length} en total. La unidad no podrá cambiarse una vez existan movimientos.</p>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={!codigo || !descripcion || !categoriaId || !tallaIds.length || !colorIds.length}>Crear referencia</button>
      </form>
    </Modal>
  );
}

function FormEdicion({ ref_, alCerrar, alGuardar }: { ref_: ReferenciaResumen; alCerrar: () => void; alGuardar: () => void }) {
  const cats = useCarga(() => api.conjunto("categorias"));
  const [descripcion, setDescripcion] = useState(ref_.descripcion);
  const [categoriaId, setCategoriaId] = useState("");
  const [unidad, setUnidad] = useState<UnidadMedida>(ref_.unidadMedida);
  const [error, setError] = useState("");

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.editarReferencia(ref_.id, { descripcion, ...(categoriaId ? { categoriaId } : {}), ...(unidad !== ref_.unidadMedida ? { unidadMedida: unidad } : {}) });
      alGuardar();
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <Modal titulo={`Editar ${ref_.codigo}`} alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="Descripción"><input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} /></Campo>
        <Campo etiqueta={`Categoría (actual: ${ref_.categoria})`}>
          <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}><option value="">Sin cambios</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
        </Campo>
        <Campo etiqueta="Unidad de medida">
          <select value={unidad} onChange={(e) => setUnidad(e.target.value as UnidadMedida)}>{UNIDADES_MEDIDA.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}</select>
        </Campo>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit">Guardar</button>
      </form>
    </Modal>
  );
}
