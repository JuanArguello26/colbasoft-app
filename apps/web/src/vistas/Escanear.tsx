import { useState, type FormEvent } from "react";
import type { ModoIdentificacion, ResolucionVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, fechaHora } from "../ui";
import { Lector } from "./Lector";

type Resultado = { ok: true; datos: ResolucionVista } | { ok: false; mensaje: string; ofrecerNovedad: boolean; anulado: boolean };

/** Escaneo con la cámara de la tablet (HU-QRC-002 criterio 1), con digitación manual como respaldo. */
export function Escanear() {
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [ultimo, setUltimo] = useState<{ codigo: string; modo: ModoIdentificacion } | null>(null);

  async function resolver(codigo: string, modo: ModoIdentificacion) {
    setError(""); setUltimo({ codigo, modo });
    try { setResultado(await api.resolver(codigo, modo)); }
    catch (e) { setError((e as Error).message); setResultado(null); }
  }

  function enviarManual(e: FormEvent) {
    e.preventDefault();
    if (manual.trim()) { void resolver(manual, "MANUAL"); setManual(""); }
  }

  return (
    <section>
      <h2>Escanear</h2>
      <p className="nota">Apunte la cámara al código QR de la etiqueta. Si no se puede leer, digítelo: quedará registrado como identificación manual.</p>
      <Lector alLeer={(c) => void resolver(c, "ESCANEO")} />
      <form onSubmit={enviarManual} className="rejilla">
        <Campo etiqueta="Código digitado"><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="COL-M-XXXXX-XXXXX" autoCapitalize="characters" /></Campo>
        <button type="submit" className="secundario" disabled={!manual.trim()}>Buscar</button>
      </form>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {resultado && !resultado.ok && (
        <Aviso tipo="error">
          {resultado.mensaje}
          {resultado.ofrecerNovedad && <> Esto puede ser una novedad: el módulo de novedades aún no está disponible en esta entrega; el intento quedó en la bitácora.</>}
          {resultado.anulado && <> La operación se rechazó.</>}
        </Aviso>
      )}
      {resultado?.ok && <Detalle r={resultado.datos} modo={ultimo?.modo} />}
    </section>
  );
}

function Detalle({ r, modo }: { r: ResolucionVista; modo: ModoIdentificacion | undefined }) {
  return (
    <article className="bloque">
      <div className="cabecera">
        <h3>{r.tipo === "MERCANCIA" ? "Mercancía" : "Ubicación"} <code>{r.identificador.codigo}</code></h3>
        <Insignia tono="ok">{modo === "MANUAL" ? "Manual" : "Escaneo"}</Insignia>
      </div>
      {r.tipo === "MERCANCIA" ? (
        <>
          <p><strong>{r.sku.referencia}</strong> · {r.sku.descripcion}<br />Talla {r.sku.talla} · {r.sku.color} · {r.sku.unidadMedida.toLowerCase()}</p>
          <p>Lote <strong>{r.lote.codigo}</strong> · origen {r.lote.origen} · ingreso {fechaHora(r.lote.fechaIngreso)}</p>
          {r.ubicaciones.length === 0
            ? <p className="nota">Sin existencia en ninguna ubicación todavía.</p>
            : <ul className="lista">{r.ubicaciones.map((u) => <li key={`${u.ubicacionId}${u.estado}`}><strong>{u.ubicacion}</strong><span>{u.cantidad} · {u.estado === "EN_RECEPCION" ? "en recepción" : "disponible"}</span></li>)}</ul>}
        </>
      ) : (
        <p>Ubicación <strong>{r.ubicacion.codigo}</strong> · zona {r.ubicacion.zona} · bodega {r.ubicacion.bodega} {!r.ubicacion.activa && <Insignia>Desactivada</Insignia>}</p>
      )}
    </article>
  );
}
