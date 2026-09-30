import { useEffect, useState, type FormEvent } from "react";
import { ROL_NOMBRE, type ReferenciaResumen, type UsuarioSesion } from "@colbasoft/shared";
import { api } from "./api";

export function App() {
  const [usuario, setUsuario] = useState<UsuarioSesion | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    api.yo().then(setUsuario).catch(() => setUsuario(null)).finally(() => setCargando(false));
  }, []);

  if (cargando) return <p className="centro">Cargando…</p>;
  if (!usuario) return <Login alIniciar={setUsuario} />;
  return <Catalogo usuario={usuario} alSalir={() => setUsuario(null)} />;
}

function Login({ alIniciar }: { alIniciar: (u: UsuarioSesion) => void }) {
  const [login, setLogin] = useState("");
  const [clave, setClave] = useState("");
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError("");
    setEnviando(true);
    try {
      alIniciar(await api.login(login, clave));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="tarjeta estrecha">
      <h1>COLBASOFT</h1>
      <p className="sub">Trazabilidad de inventarios</p>
      <form onSubmit={enviar}>
        <label>
          Usuario
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          Contraseña
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={enviando || !login || !clave}>Ingresar</button>
      </form>
      <p className="nota">Datos de demostración ficticios.</p>
    </main>
  );
}

function Catalogo({ usuario, alSalir }: { usuario: UsuarioSesion; alSalir: () => void }) {
  const [filas, setFilas] = useState<ReferenciaResumen[] | null>(null);
  const [error, setError] = useState("");
  const [filtro, setFiltro] = useState("");

  useEffect(() => {
    api.referencias().then(setFilas).catch((e: Error) => setError(e.message));
  }, []);

  async function salir() {
    await api.logout();
    alSalir();
  }

  const visibles = (filas ?? []).filter((r) => `${r.codigo} ${r.descripcion} ${r.categoria}`.toLowerCase().includes(filtro.toLowerCase()));

  return (
    <main className="tarjeta">
      <header className="cabecera">
        <div>
          <h1>Catálogo de referencias</h1>
          <p className="sub">{usuario.nombre} · {ROL_NOMBRE[usuario.rol]}</p>
        </div>
        <button className="secundario" onClick={salir}>Salir</button>
      </header>
      <input className="buscar" placeholder="Buscar por código, descripción o categoría" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      {!filas && !error && <p>Cargando…</p>}
      {filas && (
        <div className="tabla-envoltura">
          <table>
            <thead>
              <tr><th>Código</th><th>Descripción</th><th>Categoría</th><th>Unidad</th><th className="num">SKU</th></tr>
            </thead>
            <tbody>
              {visibles.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.codigo}</strong></td>
                  <td>{r.descripcion}</td>
                  <td>{r.categoria}</td>
                  <td>{r.unidadMedida.toLowerCase()}</td>
                  <td className="num">{r.skus}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="nota">{visibles.length} de {filas.length} referencias</p>
        </div>
      )}
    </main>
  );
}
