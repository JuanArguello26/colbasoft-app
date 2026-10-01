import { useState, type FormEvent } from "react";
import { UNIDADES_MEDIDA, ZONA_TIPOS, type UbicacionVista, type UnidadMedida, type ZonaTipo } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, Modal, useCarga } from "../ui";
import { Etiquetas } from "./Etiquetas";

const NOMBRE_ZONA: Record<ZonaTipo, string> = { RECEPCION: "Recepción", ALMACENAMIENTO: "Almacenamiento", PREPARACION_SALIDA: "Preparación de salida", CUARENTENA: "Cuarentena" };

export function Bodega({ puedeEditar }: { puedeEditar: boolean }) {
  const { datos, error, recargar } = useCarga(api.bodegas);
  const pend = useCarga(api.pendientesCapacidad);
  const [msg, setMsg] = useState("");
  const [nuevaBodega, setNuevaBodega] = useState(false);
  const [zonaDe, setZonaDe] = useState<string | null>(null);
  const [ubicDe, setUbicDe] = useState<string | null>(null);
  const [capDe, setCapDe] = useState<UbicacionVista | null>(null);
  const [imprimir, setImprimir] = useState<string[] | null>(null);

  const refrescar = () => { recargar(); pend.recargar(); };
  async function correr(f: () => Promise<unknown>) { setMsg(""); try { await f(); refrescar(); } catch (e) { setMsg((e as Error).message); } }
  /** HU-QRC-003: genera los QR que falten de la zona (no crea otros a las que ya lo tienen) y abre la impresión de toda la zona. */
  async function qrDeZona(zonaId: string) {
    setMsg("");
    try { setImprimir((await api.generarQrUbicaciones({ zonaId })).identificadores.map((i) => i.id)); } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <section>
      <div className="cabecera">
        <h2>Estructura de bodega</h2>
        {puedeEditar && <button onClick={() => setNuevaBodega(true)}>Nueva bodega</button>}
      </div>
      <p className="nota">Toda bodega tiene al menos una zona de recepción con una ubicación. Una ubicación sin capacidad se trata como ilimitada y figura como pendiente de configurar. Cada ubicación tiene su propio código QR, distinto del de la mercancía.</p>
      {(pend.datos?.length ?? 0) > 0 && <Aviso tipo="info">{pend.datos!.length} ubicaciones activas sin capacidad definida.</Aviso>}
      {msg && <Aviso tipo="error">{msg}</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      {(datos ?? []).map((b) => (
        <article key={b.id} className="bloque">
          <h3>{b.nombre} <small>({b.codigo})</small></h3>
          {b.zonas.map((z) => (
            <div key={z.id} className="zona">
              <div className="cabecera">
                <h4>{z.nombre} <Insignia tono={z.tipo === "RECEPCION" ? "info" : "gris"}>{NOMBRE_ZONA[z.tipo]}</Insignia> <small>{z.codigo}</small></h4>
                <span className="acciones">
                  {puedeEditar && <button className="secundario" onClick={() => qrDeZona(z.id)}>Imprimir QR de la zona</button>}
                  {puedeEditar && <button className="secundario" onClick={() => setUbicDe(z.id)}>+ Ubicación</button>}
                </span>
              </div>
              <ul className="ubicaciones">
                {z.ubicaciones.map((u) => (
                  <li key={u.id} className={u.activa ? "" : "apagado"}>
                    <strong>{u.codigo}</strong>
                    <span>{u.capacidad === null ? <Insignia tono="alerta">sin capacidad</Insignia> : `${u.capacidad} ${u.unidadCapacidad?.toLowerCase()}`}</span>
                    {!u.activa && <Insignia>Desactivada</Insignia>}
                    {puedeEditar && (
                      <span className="acciones">
                        <button className="enlace" onClick={() => setCapDe(u)}>Capacidad</button>
                        <button className="enlace" onClick={() => correr(() => api.ubicacionAccion(u.id, u.activa ? "desactivar" : "reactivar"))}>{u.activa ? "Desactivar" : "Reactivar"}</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {puedeEditar && <button className="secundario" onClick={() => setZonaDe(b.id)}>+ Zona</button>}
        </article>
      ))}
      {nuevaBodega && <FormBodega alCerrar={() => setNuevaBodega(false)} alGuardar={() => { setNuevaBodega(false); refrescar(); }} />}
      {zonaDe && <FormZona bodegaId={zonaDe} alCerrar={() => setZonaDe(null)} alGuardar={() => { setZonaDe(null); refrescar(); }} />}
      {ubicDe && <FormUbicacion zonaId={ubicDe} alCerrar={() => setUbicDe(null)} alGuardar={() => { setUbicDe(null); refrescar(); }} />}
      {imprimir && <Etiquetas ids={imprimir} alCerrar={() => setImprimir(null)} />}
      {capDe && <FormCapacidad u={capDe} alCerrar={() => setCapDe(null)} alGuardar={() => { setCapDe(null); refrescar(); }} />}
    </section>
  );
}

function Formulario({ titulo, alCerrar, onEnviar, children, deshabilitado }: { titulo: string; alCerrar: () => void; onEnviar: () => Promise<void>; children: React.ReactNode; deshabilitado?: boolean }) {
  const [error, setError] = useState("");
  async function enviar(e: FormEvent) { e.preventDefault(); setError(""); try { await onEnviar(); } catch (err) { setError((err as Error).message); } }
  return (
    <Modal titulo={titulo} alCerrar={alCerrar}>
      <form onSubmit={enviar} className="formulario">{children}{error && <Aviso tipo="error">{error}</Aviso>}<button type="submit" disabled={deshabilitado}>Guardar</button></form>
    </Modal>
  );
}

function FormBodega({ alCerrar, alGuardar }: { alCerrar: () => void; alGuardar: () => void }) {
  const [codigo, setCodigo] = useState(""); const [nombre, setNombre] = useState("");
  const [zc, setZc] = useState("REC"); const [zn, setZn] = useState("Recepción"); const [uc, setUc] = useState("REC-01");
  return (
    <Formulario titulo="Nueva bodega" alCerrar={alCerrar} onEnviar={async () => { await api.crearBodega({ codigo, nombre, zonaRecepcion: { codigo: zc, nombre: zn, ubicacionCodigo: uc } }); alGuardar(); }} deshabilitado={!codigo || !nombre}>
      <Campo etiqueta="Código"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} /></Campo>
      <Campo etiqueta="Nombre"><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      <p className="nota">La bodega nace con su zona de recepción y una ubicación:</p>
      <Campo etiqueta="Código de la zona de recepción"><input value={zc} onChange={(e) => setZc(e.target.value)} /></Campo>
      <Campo etiqueta="Nombre de la zona"><input value={zn} onChange={(e) => setZn(e.target.value)} /></Campo>
      <Campo etiqueta="Primera ubicación"><input value={uc} onChange={(e) => setUc(e.target.value)} /></Campo>
    </Formulario>
  );
}

function FormZona({ bodegaId, alCerrar, alGuardar }: { bodegaId: string; alCerrar: () => void; alGuardar: () => void }) {
  const [codigo, setCodigo] = useState(""); const [nombre, setNombre] = useState(""); const [tipo, setTipo] = useState<ZonaTipo>("ALMACENAMIENTO");
  return (
    <Formulario titulo="Nueva zona" alCerrar={alCerrar} onEnviar={async () => { await api.crearZona(bodegaId, { codigo, nombre, tipo }); alGuardar(); }} deshabilitado={!codigo || !nombre}>
      <Campo etiqueta="Código"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} /></Campo>
      <Campo etiqueta="Nombre"><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      <Campo etiqueta="Tipo"><select value={tipo} onChange={(e) => setTipo(e.target.value as ZonaTipo)}>{ZONA_TIPOS.filter((t) => t !== "RECEPCION").map((t) => <option key={t} value={t}>{NOMBRE_ZONA[t]}</option>)}</select></Campo>
    </Formulario>
  );
}

function FormUbicacion({ zonaId, alCerrar, alGuardar }: { zonaId: string; alCerrar: () => void; alGuardar: () => void }) {
  const [codigo, setCodigo] = useState(""); const [cap, setCap] = useState(""); const [unidad, setUnidad] = useState<UnidadMedida>("UNIDADES");
  return (
    <Formulario titulo="Nueva ubicación" alCerrar={alCerrar} onEnviar={async () => { await api.crearUbicacion(zonaId, { codigo, ...(cap ? { capacidad: Number(cap), unidadCapacidad: unidad } : {}) }); alGuardar(); }} deshabilitado={!codigo}>
      <Campo etiqueta="Código (único en la bodega)"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} /></Campo>
      <Campo etiqueta="Capacidad (opcional)"><input type="number" min="0" value={cap} onChange={(e) => setCap(e.target.value)} /></Campo>
      <Campo etiqueta="Unidad de la capacidad"><select value={unidad} onChange={(e) => setUnidad(e.target.value as UnidadMedida)}>{UNIDADES_MEDIDA.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}</select></Campo>
    </Formulario>
  );
}

function FormCapacidad({ u, alCerrar, alGuardar }: { u: UbicacionVista; alCerrar: () => void; alGuardar: () => void }) {
  const [cap, setCap] = useState(u.capacidad === null ? "" : String(u.capacidad)); const [unidad, setUnidad] = useState<UnidadMedida>(u.unidadCapacidad ?? "UNIDADES");
  return (
    <Formulario titulo={`Capacidad de ${u.codigo}`} alCerrar={alCerrar} onEnviar={async () => { await api.capacidad(u.id, cap === "" ? { capacidad: null, unidadCapacidad: null } : { capacidad: Number(cap), unidadCapacidad: unidad }); alGuardar(); }}>
      <Campo etiqueta="Capacidad (vacío = ilimitada)"><input type="number" min="0" value={cap} onChange={(e) => setCap(e.target.value)} /></Campo>
      <Campo etiqueta="Unidad"><select value={unidad} onChange={(e) => setUnidad(e.target.value as UnidadMedida)}>{UNIDADES_MEDIDA.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}</select></Campo>
    </Formulario>
  );
}
