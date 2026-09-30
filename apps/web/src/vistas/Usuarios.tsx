import { useState, type FormEvent } from "react";
import { ROLES, ROL_NOMBRE, type Rol } from "@colbasoft/shared";
import { api } from "../api";
import { Aviso, Campo, Insignia, useCarga } from "../ui";

export function Usuarios() {
  const { datos, error, recargar } = useCarga(api.usuarios);
  const [login, setLogin] = useState("");
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<Rol>("AUXILIAR_BODEGA");
  const [msg, setMsg] = useState<{ tipo: "error" | "ok"; texto: string } | null>(null);
  const [temporal, setTemporal] = useState<{ para: string; clave: string } | null>(null);

  async function crear(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api.crearUsuario({ login, nombre, rol });
      setTemporal({ para: r.usuario.login, clave: r.claveTemporal });
      setLogin(""); setNombre("");
      recargar();
    } catch (err) { setMsg({ tipo: "error", texto: (err as Error).message }); }
  }

  async function accion(id: string, login: string, a: "desactivar" | "reactivar" | "desbloquear") {
    setMsg(null);
    try {
      const r = await api.usuarioAccion(id, a);
      if (r.claveTemporal) setTemporal({ para: login, clave: r.claveTemporal });
      recargar();
    } catch (err) { setMsg({ tipo: "error", texto: (err as Error).message }); }
  }

  return (
    <section>
      <h2>Usuarios y roles</h2>
      <p className="nota">Existen exactamente cinco roles oficiales. Un usuario no se elimina: se desactiva y conserva su historial.</p>
      {temporal && (
        <Aviso tipo="ok">
          Contraseña temporal de <strong>{temporal.para}</strong>: <code>{temporal.clave}</code>. Se muestra <strong>una sola vez</strong>; la persona deberá cambiarla en su primer acceso.
          {" "}<button className="enlace" onClick={() => setTemporal(null)}>Ocultar</button>
        </Aviso>
      )}
      {msg && <Aviso tipo={msg.tipo}>{msg.texto}</Aviso>}
      <form className="rejilla" onSubmit={crear}>
        <Campo etiqueta="Identificador"><input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="nombre.apellido" /></Campo>
        <Campo etiqueta="Nombre"><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
        <Campo etiqueta="Rol">
          <select value={rol} onChange={(e) => setRol(e.target.value as Rol)}>{ROLES.map((r) => <option key={r} value={r}>{ROL_NOMBRE[r]}</option>)}</select>
        </Campo>
        <button type="submit" disabled={!login || !nombre}>Crear usuario</button>
      </form>
      {error && <Aviso tipo="error">{error}</Aviso>}
      <div className="tabla-envoltura">
        <table>
          <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {(datos ?? []).map((u) => (
              <tr key={u.id}>
                <td><strong>{u.login}</strong></td><td>{u.nombre}</td><td>{ROL_NOMBRE[u.rol]}</td>
                <td>
                  {u.activo ? <Insignia tono="ok">Activo</Insignia> : <Insignia>Desactivado</Insignia>}{" "}
                  {u.bloqueado && <Insignia tono="alerta">Bloqueado</Insignia>}{" "}
                  {u.debeCambiarClave && <Insignia tono="info">Debe cambiar clave</Insignia>}
                </td>
                <td className="acciones">
                  {u.bloqueado && <button className="secundario" onClick={() => accion(u.id, u.login, "desbloquear")}>Desbloquear</button>}
                  {u.activo ? <button className="secundario" onClick={() => accion(u.id, u.login, "desactivar")}>Desactivar</button> : <button className="secundario" onClick={() => accion(u.id, u.login, "reactivar")}>Reactivar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
