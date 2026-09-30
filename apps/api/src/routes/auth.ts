import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SesionInfo, UsuarioSesion } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar, registrarSuelto } from "../bitacora.js";
import { valorParametro } from "../parametros.js";
import { emitirSesion } from "../sesion.js";
import { hashClave, validarClaveNueva, verificarClave } from "../seguridad.js";

const cuerpoLogin = z.object({ login: z.string().min(1).max(64), clave: z.string().min(1).max(200) });
const cuerpoCambio = z.object({ claveActual: z.string().min(1), claveNueva: z.string().min(1).max(200) });

export const rutasAuth: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    const datos = cuerpoLogin.safeParse(req.body);
    // Mismo mensaje para cualquier fallo: no revela si el usuario o la clave fue el incorrecto (HU-ACC-001 criterio 4).
    const rechazo = () => reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    if (!datos.success) return rechazo();
    const { login, clave } = datos.data;
    const origen = req.ip;

    const usuario = await prisma.usuario.findUnique({ where: { login } });
    const fallo = (motivo: string) =>
      registrarSuelto({
        actor: { tipo: "USUARIO", usuarioId: usuario?.id ?? null, usuarioLogin: login },
        modulo: "ACCESO",
        evento: "acceso_fallido",
        detalle: { motivo },
        origen,
      });

    if (!usuario || !usuario.activo) {
      await fallo(usuario ? "usuario_desactivado" : "usuario_desconocido");
      return rechazo();
    }
    if (usuario.bloqueado) {
      await fallo("cuenta_bloqueada");
      return rechazo();
    }
    if (!verificarClave(clave, usuario.passwordHash)) {
      const limite = await valorParametro("intentos_bloqueo");
      const intentos = usuario.intentosFallidos + 1;
      const bloquear = intentos >= limite;
      await prisma.$transaction(async (tx) => {
        await tx.usuario.update({ where: { id: usuario.id }, data: { intentosFallidos: intentos, bloqueado: bloquear } });
        await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: usuario.id, usuarioLogin: login }, modulo: "ACCESO", evento: "acceso_fallido", detalle: { motivo: "clave_incorrecta", intentos }, origen });
        // RF-ACC-004: se bloquea y queda el aviso para el Administrador (la notificación llega con M-20).
        if (bloquear) await registrar(tx, { actor: { tipo: "SISTEMA" }, modulo: "ACCESO", evento: "cuenta_bloqueada", entidad: "Usuario", entidadId: usuario.id, detalle: { login, intentos }, origen });
      });
      return rechazo();
    }

    await prisma.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id: usuario.id }, data: { intentosFallidos: 0 } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: usuario.id, usuarioLogin: login }, modulo: "ACCESO", evento: "acceso_exitoso", origen });
    });

    const sesion: UsuarioSesion = { id: usuario.id, login: usuario.login, nombre: usuario.nombre, rol: usuario.rol };
    await emitirSesion(app, reply, sesion);
    return { ...sesion, debeCambiarClave: usuario.debeCambiarClave };
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies.token;
    const previo = token ? app.jwt.decode<UsuarioSesion>(token) : null;
    if (previo) {
      await registrarSuelto({ actor: { tipo: "USUARIO", usuarioId: previo.id, usuarioLogin: previo.login }, modulo: "ACCESO", evento: "sesion_cerrada", origen: req.ip });
    }
    reply.clearCookie("token", { path: "/" });
    return { ok: true };
  });

  /** Estado de la sesión. No cuenta como actividad: consultarla no la prolonga. */
  app.get("/yo", { preHandler: app.autenticar }, async (req): Promise<SesionInfo> => {
    const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id: req.user.id } });
    const exp = (req.user as unknown as { exp?: number }).exp;
    return {
      ...req.user,
      debeCambiarClave: usuario.debeCambiarClave,
      expiraEn: (exp ?? 0) * 1000,
      avisoSegundos: await valorParametro("aviso_inactividad_segundos"),
    };
  });

  /** El usuario confirma que sigue ahí (responde al aviso de inactividad). */
  app.post("/renovar", { preHandler: app.autenticar }, async () => ({ ok: true }));

  app.post("/cambiar-clave", { preHandler: app.autenticar }, async (req, reply) => {
    const datos = cuerpoCambio.safeParse(req.body);
    if (!datos.success) return reply.code(422).send({ error: "Datos incompletos." });
    const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id: req.user.id } });
    if (!verificarClave(datos.data.claveActual, usuario.passwordHash)) return reply.code(422).send({ error: "La contraseña actual no es correcta." });
    if (datos.data.claveNueva === datos.data.claveActual) return reply.code(422).send({ error: "La contraseña nueva debe ser distinta de la actual." });
    const problema = validarClaveNueva(datos.data.claveNueva, usuario.login);
    if (problema) return reply.code(422).send({ error: problema });

    await prisma.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id: usuario.id }, data: { passwordHash: hashClave(datos.data.claveNueva), debeCambiarClave: false } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: usuario.id, usuarioLogin: usuario.login }, modulo: "ACCESO", evento: "clave_cambiada", origen: req.ip });
    });
    return { ok: true };
  });
};
