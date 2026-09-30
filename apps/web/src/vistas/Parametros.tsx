import { useState } from "react";
import type { ParametroVista } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Insignia, useCarga } from "../ui";

export function Parametros({ puedeEditar }: { puedeEditar: boolean }) {
  const { datos, error, recargar } = useCarga(api.parametros);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tipo: "error" | "ok"; texto: string } | null>(null);

  async function guardar(p: ParametroVista) {
    setMsg(null);
    const valor = Number(valores[p.clave]);
    try {
      const r = await api.guardarParametro(p.clave, valor);
      setMsg({ tipo: "ok", texto: `«${p.descripcion}» cambió de ${r.anterior} a ${r.nuevo}. Rige desde ahora; no es retroactivo.` });
      setValores((v) => { const c = { ...v }; delete c[p.clave]; return c; });
      recargar();
    } catch (err) { setMsg({ tipo: "error", texto: (err as Error).message }); }
  }

  return (
    <section>
      <h2>Parámetros</h2>
      <Aviso tipo="info">Los valores y rangos son de <strong>demostración</strong> (el SPEC no fija valores numéricos; se calibran con datos reales). {puedeEditar ? "Todo cambio queda en la bitácora con el valor anterior y el nuevo." : "Usted puede consultarlos, no modificarlos."}</Aviso>
      {msg && <Aviso tipo={msg.tipo}>{msg.texto}</Aviso>}
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>Parámetro</th><th className="num">Valor</th><th>Unidad</th><th>Rango admisible</th>{puedeEditar && <th></th>}</tr></thead>
          <tbody>
            {(datos ?? []).map((p) => (
              <tr key={p.clave}>
                <td>{p.descripcion} {p.modificado && <Insignia tono="info">Modificado</Insignia>}</td>
                <td className="num">
                  {puedeEditar
                    ? <input className="corto" type="number" value={valores[p.clave] ?? String(p.valor)} onChange={(e) => setValores((v) => ({ ...v, [p.clave]: e.target.value }))} />
                    : <strong>{p.valor}</strong>}
                </td>
                <td>{p.unidad}</td><td>{p.minimo} a {p.maximo}</td>
                {puedeEditar && <td><button className="secundario" disabled={valores[p.clave] === undefined || Number(valores[p.clave]) === p.valor} onClick={() => guardar(p)}>Guardar</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
