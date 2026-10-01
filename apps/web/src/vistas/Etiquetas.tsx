import type { EtiquetaVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Modal, useCarga } from "../ui";

/** Vista previa e impresión de etiquetas QR (HU-QRC-001 criterios 2 y 3). La impresión usa la del navegador. */
export function Etiquetas({ ids, alCerrar }: { ids: string[]; alCerrar: () => void }) {
  const { datos, error, cargando } = useCarga(() => api.etiquetas(ids), [ids.join(",")]);
  return (
    <Modal titulo={`Imprimir ${ids.length} ${ids.length === 1 ? "etiqueta" : "etiquetas"}`} alCerrar={alCerrar}>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {cargando && <p>Preparando etiquetas…</p>}
      {datos && (
        <>
          <button onClick={() => window.print()}>Imprimir</button>
          <div className="hoja-etiquetas">{datos.map((e) => <Etiqueta key={e.id} e={e} />)}</div>
        </>
      )}
    </Modal>
  );
}

function Etiqueta({ e }: { e: EtiquetaVista }) {
  return (
    <figure className="etiqueta">
      {/* El SVG lo genera el servidor a partir del código; no incluye entrada de usuario. */}
      <div className="qr" dangerouslySetInnerHTML={{ __html: e.svg }} />
      <figcaption>
        {e.mercancia && (
          <>
            <strong>{e.mercancia.referencia}</strong>
            <span>{e.mercancia.descripcion}</span>
            <span>Talla {e.mercancia.talla} · {e.mercancia.color}</span>
            <span>Lote {e.mercancia.lote}</span>
          </>
        )}
        {e.ubicacion && (
          <>
            <strong>Ubicación {e.ubicacion.codigo}</strong>
            <span>Bodega {e.ubicacion.bodega} · Zona {e.ubicacion.zona}</span>
          </>
        )}
        <code>{e.codigo}</code>
      </figcaption>
    </figure>
  );
}
