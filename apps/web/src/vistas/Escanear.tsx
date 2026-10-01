import { useEffect, useRef, useState, type FormEvent } from "react";
import jsQR from "jsqr";
import type { ModoIdentificacion, ResolucionVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, fechaHora } from "../ui";

type Resultado = { ok: true; datos: ResolucionVista } | { ok: false; mensaje: string; ofrecerNovedad: boolean; anulado: boolean };

/** Escaneo con la cámara de la tablet (HU-QRC-002 criterio 1), con digitación manual como respaldo. */
export function Escanear() {
  const [camara, setCamara] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [ultimo, setUltimo] = useState<{ codigo: string; modo: ModoIdentificacion } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const ocupado = useRef(false);

  async function resolver(codigo: string, modo: ModoIdentificacion) {
    if (ocupado.current) return;
    ocupado.current = true;
    setError(""); setUltimo({ codigo, modo });
    try { setResultado(await api.resolver(codigo, modo)); }
    catch (e) { setError((e as Error).message); setResultado(null); }
    finally { setTimeout(() => { ocupado.current = false; }, 1500); } // evita releer el mismo QR en cada fotograma
  }

  useEffect(() => {
    if (!camara) return;
    let flujo: MediaStream | undefined;
    let vivo = true;
    const lienzo = document.createElement("canvas");
    const ctx = lienzo.getContext("2d", { willReadFrequently: true });

    function mirar() {
      const v = video.current;
      if (!vivo || !v || !ctx) return;
      if (v.readyState === v.HAVE_ENOUGH_DATA && !ocupado.current) {
        lienzo.width = v.videoWidth; lienzo.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const q = jsQR(ctx.getImageData(0, 0, lienzo.width, lienzo.height).data, lienzo.width, lienzo.height);
        if (q?.data) void resolver(q.data, "ESCANEO");
      }
      requestAnimationFrame(mirar);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((f) => {
        if (!vivo) return f.getTracks().forEach((t) => t.stop());
        flujo = f;
        if (video.current) { video.current.srcObject = f; void video.current.play(); }
        requestAnimationFrame(mirar);
      })
      .catch(() => { setError("No se pudo abrir la cámara. Revise el permiso del navegador (y que la página use HTTPS o localhost) o digite el código."); setCamara(false); });
    return () => { vivo = false; flujo?.getTracks().forEach((t) => t.stop()); };
  }, [camara]);

  function enviarManual(e: FormEvent) {
    e.preventDefault();
    if (manual.trim()) { void resolver(manual, "MANUAL"); setManual(""); }
  }

  return (
    <section>
      <h2>Escanear</h2>
      <p className="nota">Apunte la cámara al código QR de la etiqueta. Si no se puede leer, digítelo: quedará registrado como identificación manual.</p>
      <div className="acciones">
        <button onClick={() => setCamara((c) => !c)}>{camara ? "Apagar cámara" : "Encender cámara"}</button>
      </div>
      {camara && <video ref={video} className="visor" muted playsInline />}
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
            : <ul className="lista">{r.ubicaciones.map((u) => <li key={u.ubicacionId}><strong>{u.ubicacion}</strong><span>{u.cantidad}</span></li>)}</ul>}
        </>
      ) : (
        <p>Ubicación <strong>{r.ubicacion.codigo}</strong> · zona {r.ubicacion.zona} · bodega {r.ubicacion.bodega} {!r.ubicacion.activa && <Insignia>Desactivada</Insignia>}</p>
      )}
    </article>
  );
}
