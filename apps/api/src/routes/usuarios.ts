import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ROLES, type UsuarioAdmin } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { requiereRol } from "../permisos.js";
import { claveTemporal, hashClave } from "../seguridad.js";

const soloAdmin = requiereRol("ADMINISTRADOR");
const cuerpoCrear = z.object({
  login: z.string().trim().min(3).max(40).regex(/^[a-z0-9._-]+$/, "Use minúsculas, números, punto, guion o guion bajo."),
  nombre: z.string().trim().min(2).max(120),
  rol: z.enum(ROLES),
});

const vista = (u: { id: string; login: string; nombre: string; rol: UsuarioAdmin["rol"]; activo: boolean; bloqueado: boolean; intentosFallidos: number; debeCambiarClave: boolean }): UsuarioAdmin => ({
  id: u.id, login: u.login, nombre: u.nombre, rol: u.rol, activo: u.activo, bloqueado: u.bloqueado, intentosFallidos: u.intentosFallidos, debeCambiarClave: u.debeCambiarClave,
});

export const rutasUsuarios: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: soloAdmin }, async () => (await prisma.usuario.findMany({ orderBy: { login: "asc" } })).map(vista));

  /** HU-USR-001: crea el usuario con un rol oficial y una contraseña temporal que se muestra una sola vez. */
  app.post("/", { preHandler: soloAdmin }, async (req, reply) => {
    const datos = cuerpoCrear.safeParse(req.body);
    if (!datos.success) return reply.code(422).send({ error: datos.error.issues[0]?.message ?? "Datos no válidos." });
    // RN-014: el identificador de usuario es único en todo el sistema. No existen cuentas genéricas (RF-ACC-002).
    if (await prisma.usuario.findUnique({ where: { login: datos.data.login } })) return reply.code(409).send({ error: "Ya existe un usuario con ese identificador." });

    const temporal = claveTemporal();
    const u = await prisma.$transaction(async (tx) => {
      const nuevo = await tx.usuario.create({ data: { ...datos.data, passwordHash: hashClave(temporal), debeCambiarClave: true } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "USUARIOS", evento: "usuario_creado", entidad: "Usuario", entidadId: nuevo.id, detalle: { login: nuevo.login, rol: nuevo.rol }, origen: req.ip });
      return nuevo;
    });
    return reply.code(201).send({ usuario: vista(u), claveTemporal: temporal });
  });

  /** HU-USR-002: desactivar cierra el acceso de inmediato; no existe la opción de eliminar (RN-063). */
  app.post("/:id/desactivar", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = await prisma.usuario.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: "Usuario no encontrado." });
    if (!u.activo) return reply.code(409).send({ error: "El usuario ya está desactivado." });
    // RN-011: no se puede dejar al sistema sin Administrador activo.
    if (u.rol === "ADMINISTRADOR") {
      const otros = await prisma.usuario.count({ where: { rol: "ADMINISTRADOR", activo: true, id: { not: id } } });
      if (otros === 0) return reply.code(409).send({ error: "No se puede desactivar al último Administrador activo." });
    }
    await prisma.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id }, data: { activo: false } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "USUARIOS", evento: "usuario_desactivado", entidad: "Usuario", entidadId: id, detalle: { login: u.login }, origen: req.ip });
    });
    return { ok: true };
  });

  app.post("/:id/reactivar", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = await prisma.usuario.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: "Usuario no encontrado." });
    if (u.activo) return reply.code(409).send({ error: "El usuario ya está activo." });
    await prisma.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id }, data: { activo: true } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "USUARIOS", evento: "usuario_reactivado", entidad: "Usuario", entidadId: id, detalle: { login: u.login }, origen: req.ip });
    });
    return { ok: true };
  });

  /** Anticipado de HU-ACC-004 (fuera del corte C1): sin esto una cuenta bloqueada no tendría cómo recuperarse. */
  app.post("/:id/desbloquear", { preHandler: soloAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = await prisma.usuario.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: "Usuario no encontrado." });
    if (!u.bloqueado) return reply.code(409).send({ error: "La cuenta no está bloqueada." });
    const temporal = claveTemporal();
    await prisma.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id }, data: { bloqueado: false, intentosFallidos: 0, passwordHash: hashClave(temporal), debeCambiarClave: true } });
      await registrar(tx, { actor: { tipo: "USUARIO", usuarioId: req.user.id, usuarioLogin: req.user.login }, modulo: "USUARIOS", evento: "cuenta_desbloqueada", entidad: "Usuario", entidadId: id, detalle: { login: u.login }, origen: req.ip });
    });
    return { ok: true, claveTemporal: temporal };
  });
};
