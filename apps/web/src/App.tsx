import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ROL_NOMBRE, type Rol, type SesionInfo } from "@colbasoft/shared";
import { api, ErrorApi, suscribirActividad } from "./api";
import { Aviso, Campo } from "./ui";
import { Bitacora } from "./vistas/Bitacora";
import { Bodega } from "./vistas/Bodega";
import { Catalogo } from "./vistas/Catalogo";
import { Entradas } from "./vistas/Entradas";
import { Escanear } from "./vistas/Escanear";
import { Identificacion } from "./vistas/Identificacion";
import { Motivos } from "./vistas/Motivos";
import { Parametros } from "./vistas/Parametros";
import { Usuarios } from "./vistas/Usuarios";

type Vista = "catalogo" | "entradas" | "identificacion" | "escanear" | "bodega" | "motivos" | "usuarios" | "parametros" | "bitacora";

interface Pestana { id: Vista; titulo: string; roles: Rol[] | "todos" }
const PESTANAS: Pestana[] = [
  { id: "catalogo", titulo: "Catálogo", roles: "todos" },
  { id: "entradas", titulo: "Entradas", roles: "todos" },
  { id: "identificacion", titulo: "Lotes y QR", roles: "todos" },
  { id: "escanear", titulo: "Escanear", roles: ["ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA", "AUXILIAR_BODEGA"] },
  { id: "bodega", titulo: "Bodega", roles: "todos" },
  { id: "motivos", titulo: "Motivos", roles: "todos" },
  { id: "parametros", titulo: "Parámetros", roles: ["ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA"] },
  { id: "usuarios", titulo: "Usuarios", roles: ["ADMINISTRADOR"] },
  { id: "bitacora", titulo: "Bitácora", roles: ["ADMINISTRADOR", "AUDITOR", "JEFE_BODEGA"] },
];

export function App() {
  const [sesion, setSesion] = useState<SesionInfo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [aviso, setAviso] = useState("");

  const refrescar = useCallback(async () => {
    try { setSesion(await api.yo()); }
    catch (e) { if (e instanceof ErrorApi && e.estado === 401) { setSesion(null); if (e.message.includes("inactividad")) setAviso(e.message); } }
  }, []);

  useEffect(() => { refrescar().finally(() => setCargando(false)); }, [refrescar]);
  useEffect(() => { suscribirActividad(() => { void refrescar(); }); }, [refrescar]);

  if (cargando) return <p className="centro">Cargando…</p>;
  if (!sesion) return <Login aviso={aviso} alIniciar={refrescar} />;
  if (sesion.debeCambiarClave) return <CambiarClave sesion={sesion} alCambiar={refrescar} alSalir={() => setSesion(null)} />;
  return <Shell sesion={sesion} refrescar={refrescar} alSalir={(m) => { setAviso(m ?? ""); setSesion(null); }} />;
}

function Login({ aviso, alIniciar }: { aviso: string; alIniciar: () => Promise<void> }) {
  const [login, setLogin] = useState("");
  const [clave, setClave] = useState("");
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError(""); setEnviando(true);
    try { await api.login(login, clave); await alIniciar(); }
    catch (err) { setError(err instanceof Error ? err.message : "No se pudo iniciar sesión."); }
    finally { setEnviando(false); }
  }

  return (
    <main className="tarjeta estrecha">
      <h1>COLBASOFT</h1>
      <p className="sub">Trazabilidad de inventarios</p>
      {aviso && <Aviso tipo="info">{aviso}</Aviso>}
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="Usuario"><input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus /></Campo>
        <Campo etiqueta="Contraseña"><input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="current-password" /></Campo>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={enviando || !login || !clave}>Ingresar</button>
      </form>
      <p className="nota">Datos de demostración ficticios.</p>
    </main>
  );
}

function CambiarClave({ sesion, alCambiar, alSalir }: { sesion: SesionInfo; alCambiar: () => Promise<void>; alSalir: () => void }) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetida, setRepetida] = useState("");
  const [error, setError] = useState("");

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (nueva !== repetida) return setError("Las contraseñas nuevas no coinciden.");
    try { await api.cambiarClave(actual, nueva); await alCambiar(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <main className="tarjeta estrecha">
      <h1>Cambie su contraseña</h1>
      <p className="sub">{sesion.nombre}: debe elegir una contraseña propia antes de continuar.</p>
      <form onSubmit={enviar} className="formulario">
        <Campo etiqueta="Contraseña actual (la temporal)"><input type="password" value={actual} onChange={(e) => setActual(e.target.value)} autoComplete="current-password" /></Campo>
        <Campo etiqueta="Contraseña nueva"><input type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} autoComplete="new-password" /></Campo>
        <Campo etiqueta="Repita la contraseña nueva"><input type="password" value={repetida} onChange={(e) => setRepetida(e.target.value)} autoComplete="new-password" /></Campo>
        <p className="nota">Mínimo 8 caracteres, con letras y números, sin incluir su usuario.</p>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <button type="submit" disabled={!actual || !nueva || !repetida}>Cambiar contraseña</button>
        <button type="button" className="secundario" onClick={async () => { await api.logout(); alSalir(); }}>Salir</button>
      </form>
    </main>
  );
}

function Shell({ sesion, refrescar, alSalir }: { sesion: SesionInfo; refrescar: () => Promise<void>; alSalir: (mensaje?: string) => void }) {
  const visibles = PESTANAS.filter((p) => p.roles === "todos" || p.roles.includes(sesion.rol));
  const [vista, setVista] = useState<Vista>("catalogo");
  const rol = sesion.rol;

  // Sesión por inactividad (HU-ACC-002): aviso previo, renovación y cierre.
  const [restante, setRestante] = useState(Infinity);
  const ultimoPulso = useRef(0);
  useEffect(() => {
    const t = setInterval(() => setRestante(Math.round((sesion.expiraEn - Date.now()) / 1000)), 1000);
    return () => clearInterval(t);
  }, [sesion.expiraEn]);
  useEffect(() => {
    if (restante <= 0) { void api.logout().finally(() => alSalir("La sesión se cerró por inactividad.")); }
  }, [restante, alSalir]);
  // Mientras la persona escribe o toca la pantalla, se informa al servidor (máximo una vez cada 30 s).
  useEffect(() => {
    const pulso = () => {
      const ahora = Date.now();
      if (ahora - ultimoPulso.current < 30_000) return;
      ultimoPulso.current = ahora;
      void api.renovar().then(refrescar).catch(() => undefined);
    };
    const eventos = ["keydown", "pointerdown"] as const;
    eventos.forEach((e) => window.addEventListener(e, pulso));
    return () => eventos.forEach((e) => window.removeEventListener(e, pulso));
  }, [refrescar]);

  async function salir() { await api.logout(); alSalir(); }
  async function seguir() { await api.renovar(); await refrescar(); }

  return (
    <div className="aplicacion">
      <header className="barra">
        <div><strong>COLBASOFT</strong> <span className="sub">{sesion.nombre} · {ROL_NOMBRE[rol]}</span></div>
        <button className="secundario" onClick={salir}>Salir</button>
      </header>
      <nav className="pestanas" aria-label="Secciones">
        {visibles.map((p) => <button key={p.id} className={vista === p.id ? "activa" : ""} onClick={() => setVista(p.id)}>{p.titulo}</button>)}
      </nav>
      <main className="tarjeta">
        {vista === "catalogo" && <Catalogo puedeEditar={rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA"} />}
        {vista === "entradas" && (
          <Entradas permisos={{
            crear: rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA" || rol === "COORDINADOR_BODEGA",
            recibir: rol !== "AUDITOR",
            confirmar: rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA" || rol === "COORDINADOR_BODEGA",
            autorizar: rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA",
            verDesviaciones: rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA" || rol === "COORDINADOR_BODEGA",
          }} />
        )}
        {vista === "identificacion" && <Identificacion puedeGenerar={rol === "ADMINISTRADOR" || rol === "JEFE_BODEGA" || rol === "COORDINADOR_BODEGA"} />}
        {vista === "escanear" && <Escanear />}
        {vista === "bodega" && <Bodega puedeEditar={rol === "ADMINISTRADOR"} />}
        {vista === "motivos" && <Motivos puedeEditar={rol === "ADMINISTRADOR"} />}
        {vista === "parametros" && <Parametros puedeEditar={rol === "ADMINISTRADOR"} />}
        {vista === "usuarios" && <Usuarios />}
        {vista === "bitacora" && <Bitacora puedeExportar={rol === "ADMINISTRADOR" || rol === "AUDITOR"} />}
      </main>
      {restante > 0 && restante <= sesion.avisoSegundos && (
        <div className="modal-fondo" role="alertdialog" aria-label="Sesión por expirar">
          <div className="modal estrecho">
            <h2>¿Sigue ahí?</h2>
            <p>Por inactividad, su sesión se cerrará en <strong>{restante} s</strong>. Lo que tenga sin guardar se perderá.</p>
            <button onClick={seguir}>Seguir conectado</button>
          </div>
        </div>
      )}
    </div>
  );
}
