import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Aviso } from "../ui";

/**
 * Lector de códigos QR con la cámara de la tablet (HU-QRC-002 criterio 1). Entrega cada código leído a `alLeer`; el mismo código no se
 * repite hasta que pasa `pausaMs`. Exige HTTPS o localhost (getUserMedia) y permiso de cámara; si falla, el llamador ofrece digitar el código.
 */
export function Lector({ alLeer, pausaMs = 1500 }: { alLeer: (codigo: string) => void; pausaMs?: number }) {
  const [activo, setActivo] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(alLeer);
  callback.current = alLeer;

  useEffect(() => {
    if (!activo) return;
    let flujo: MediaStream | undefined;
    let vivo = true;
    let pausado = false;
    const lienzo = document.createElement("canvas");
    const ctx = lienzo.getContext("2d", { willReadFrequently: true });

    function mirar() {
      const v = video.current;
      if (!vivo || !v || !ctx) return;
      if (v.readyState === v.HAVE_ENOUGH_DATA && !pausado) {
        lienzo.width = v.videoWidth; lienzo.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const q = jsQR(ctx.getImageData(0, 0, lienzo.width, lienzo.height).data, lienzo.width, lienzo.height);
        if (q?.data) { pausado = true; callback.current(q.data); setTimeout(() => { pausado = false; }, pausaMs); }
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
      .catch(() => { setError("No se pudo abrir la cámara. Revise el permiso del navegador (y que la página use HTTPS o localhost) o digite el código."); setActivo(false); });
    return () => { vivo = false; flujo?.getTracks().forEach((t) => t.stop()); };
  }, [activo, pausaMs]);

  return (
    <div>
      <button type="button" className="secundario" onClick={() => { setError(""); setActivo((a) => !a); }}>{activo ? "Apagar cámara" : "Escanear con la cámara"}</button>
      {activo && <video ref={video} className="visor" muted playsInline />}
      {error && <Aviso tipo="error">{error}</Aviso>}
    </div>
  );
}
