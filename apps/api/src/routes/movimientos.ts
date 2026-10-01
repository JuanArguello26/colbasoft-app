import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { EstadoExistencia, ModoIdentificacion, MovimientoInternoResultado, PiezasMovibles } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { aMilesimas, errorDeDestino, type ContextoPieza } from "../entradas.js";
import { existenciaDePiezas } from "../inventario.js";
import { requiereRol } from "../permisos.js";
import { skuVista } from "./lotes.js";

/** Matriz de permisos: registrar movimientos internos = Auxiliar y quienes lo supervisan; el Auditor nunca escribe inventario. */
const opera = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA", "AUXILIAR_BODEGA");

class ErrorHttp extends Error {
  constructor(public estado: number, mensaje: string, public extra: object = {}) { super(mensaje); }
}
type Manejador = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/** Los rechazos de negocio se lanzan como ErrorHttp desde dentro de la transacción, para que deshaga todo lo hecho. */
const manejar = (f: Manejador): Manejador => async (req, reply) => {
  try { return await f(req, reply); }
  catch (e) {
    if (e instanceof ErrorHttp) return reply.code(e.estado).send({ error: e.message, ...e.extra });
    // Dos movimientos simultáneos de la misma pieza: la base rechaza el segundo (RN-EXI-001).
    if (e instanceof Error && e.message.includes("(RN-EXI-001)")) return reply.code(409).send({ error: "La pieza ya no está en esa ubicación: alguien la movió antes. Vuelva a consultarla." });
    throw e;
  }
};

const texto = z.string().trim().min(1).max(60);
const consultaPiezas = z.object({ mercanciaCodigo: texto.optional(), loteId: z.string().min(1).optional(), ubicacionCodigo: texto.optional(), ubicacionId: z.string().min(1).optional() })
  .refine((q) => q.mercanciaCodigo || q.loteId, "Escanee el QR de la mercancía o elija el lote.");
const mover = z.object({
  piezaId: z.string({ required_error: "Elija la pieza que mueve.", invalid_type_error: "Elija la pieza que mueve." }).min(1, "Elija la pieza que mueve."),
  origenCodigo: texto.optional(), origenId: z.string().min(1).optional(),
  destinoCodigo: texto.optional(), destinoId: z.string().min(1).optional(),
  mercanciaCodigo: texto.optional(),
  /** Si se indica, debe ser la cantidad completa de la pieza: una pieza no se divide (RN-MOV-012). */
  cantidad: z.number({ invalid_type_error: "La cantidad no es válida." }).optional(),
  iniciadoEn: z.string().datetime().optional(),
});

type Cliente = Prisma.TransactionClient | typeof prisma;

/** Un QR de ubicación (escaneado) → su ubicación. */
async function ubicacionDeCodigo(c: Cliente, codigo: string): Promise<string> {
  const ident = await c.identificador.findUnique({ where: { codigo: codigo.toUpperCase() } });
  if (!ident || ident.tipo !== "UBICACION" || !ident.ubicacionId) throw new ErrorHttp(409, "El código escaneado no es el de una ubicación.");
  if (ident.estado === "ANULADO") throw new ErrorHttp(409, "El identificador de la ubicación está anulado.");
  return ident.ubicacionId;
}

/** Un QR de mercancía (escaneado) → su lote. */
async function loteDeCodigo(c: Cliente, codigo: string): Promise<string> {
  const ident = await c.identificador.findUnique({ where: { codigo: codigo.toUpperCase() } });
  if (!ident || ident.tipo !== "MERCANCIA" || !ident.loteId) throw new ErrorHttp(404, "El código de mercancía no está registrado.", { reconocido: false, ofrecerNovedad: true });
  if (ident.estado === "ANULADO") throw new ErrorHttp(409, "El identificador de la mercancía está anulado: no se puede operar con él.");
  return ident.loteId;
}

export const rutasMovimientos: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });

  /**
   * HU-MOV-008 criterios 1 y 2: tras escanear el QR del SKU + Lote se muestran las piezas del lote y la persona elige la que mueve;
   * la ubicación (escaneada o elegida) filtra y verifica qué piezas se ofrecen. Solo se listan las que tienen existencia. Leer no escribe.
   */
  app.get("/piezas", manejar(async (req, reply): Promise<PiezasMovibles | void> => {
    const q = consultaPiezas.safeParse(req.query);
    if (!q.success) return reply.code(422).send({ error: q.error.issues[0]?.message ?? "Datos no válidos." });
    const loteId = q.data.mercanciaCodigo ? await loteDeCodigo(prisma, q.data.mercanciaCodigo) : q.data.loteId!;
    const filtroUbicacion = q.data.ubicacionCodigo ? await ubicacionDeCodigo(prisma, q.data.ubicacionCodigo) : q.data.ubicacionId;
    const lote = await prisma.lote.findUnique({ where: { id: loteId }, include: { sku: { include: { referencia: true, talla: true, color: true } } } });
    if (!lote) throw new ErrorHttp(404, "Lote no encontrado.");
    const piezas = await prisma.pieza.findMany({ where: { linea: { loteId } }, orderBy: { numero: "asc" } });
    const donde = await existenciaDePiezas(piezas.map((p) => p.id));
    const lista = piezas.flatMap((p) => (donde.get(p.id) ?? [])
      .filter((u) => !filtroUbicacion || u.ubicacionId === filtroUbicacion)
      .map((u) => ({ id: p.id, numero: p.numero, tipo: p.tipo, cantidad: u.cantidad, ubicacionId: u.ubicacionId, ubicacion: u.ubicacion, estado: u.estado, movible: u.estado === "DISPONIBLE" })));
    return { lote: { id: lote.id, codigo: lote.codigo, sku: skuVista(lote.sku) }, piezas: lista };
  }));

  /**
   * HU-MOV-001, HU-MOV-002 y HU-MOV-008: mueve una pieza completa de su ubicación a otra. Un solo movimiento con dos asientos (−origen, +destino)
   * en una transacción: el total no cambia (RN-MOV-004) y el descuento y el incremento son indivisibles. Cada rechazo explica el motivo.
   */
  app.post("/internos", { preHandler: opera }, manejar(async (req, reply) => {
    const d = mover.safeParse(req.body);
    // Los mensajes por defecto de la validación («Required») no los entiende quien opera: se explican en lenguaje llano (HU-MOV-002 criterio 5).
    if (!d.success) throw new ErrorHttp(422, d.error.issues.find((i) => i.message !== "Required")?.message ?? "Faltan datos del movimiento: elija la pieza y la ubicación destino.");
    if (!d.data.destinoCodigo && !d.data.destinoId) throw new ErrorHttp(422, "Indique la ubicación destino: escanee su QR o selecciónela.");

    const resultado = await prisma.$transaction(async (tx): Promise<MovimientoInternoResultado> => {
      const pieza = await tx.pieza.findUnique({ where: { id: d.data.piezaId }, include: { linea: { include: { sku: { include: { referencia: true } }, documento: true } } } });
      if (!pieza) throw new ErrorHttp(404, "Pieza no encontrada.");

      // La mercancía escaneada debe ser la de esta pieza (mismo SKU + Lote).
      if (d.data.mercanciaCodigo && (await loteDeCodigo(tx, d.data.mercanciaCodigo)) !== pieza.linea.loteId) {
        throw new ErrorHttp(409, "La mercancía escaneada no corresponde a esta pieza (otro SKU o lote).");
      }
      const donde = (await existenciaDePiezas([pieza.id], tx)).get(pieza.id) ?? [];
      // Origen indicado (escaneado o elegido): verifica que la pieza esté ahí (RN-MOV-011).
      const origenIndicado = d.data.origenCodigo ? await ubicacionDeCodigo(tx, d.data.origenCodigo) : d.data.origenId;
      const aqui = origenIndicado ? donde.filter((x) => x.ubicacionId === origenIndicado) : donde;
      if (aqui.length === 0) throw new ErrorHttp(409, donde.length === 0 ? "Esta pieza no tiene existencia: no hay nada que mover." : "El sistema no registra esa pieza en la ubicación de origen indicada.");
      // Una pieza reservada en parte para una salida no se mueve: moverla sería dividirla (RN-MOV-012).
      if (aqui.some((x) => x.estado === "RESERVADO")) throw new ErrorHttp(409, "La pieza está reservada, en todo o en parte, para una salida: no se puede mover hasta que la salida se confirme o se cancele.");
      const origen = aqui.find((x) => x.estado === "DISPONIBLE");
      if (!origen) {
        const estado: EstadoExistencia = aqui[0]!.estado;
        throw new ErrorHttp(409, estado === "EN_RECEPCION"
          ? "La pieza sigue en recepción: su primera ubicación se hace desde la entrada, no como movimiento interno."
          : "La existencia de esa pieza no está disponible: no se puede mover.");
      }

      // RN-MOV-012: la pieza se mueve completa. Más de lo que hay se rechaza (RN-EXI-003); menos es un corte parcial, que se registra como salida.
      const completa = aMilesimas(origen.cantidad);
      if (d.data.cantidad !== undefined) {
        const pedida = aMilesimas(d.data.cantidad);
        if (pedida > completa) throw new ErrorHttp(409, `No se puede mover más de lo que hay: la pieza tiene ${origen.cantidad} en ${origen.ubicacion}.`);
        if (pedida < completa) throw new ErrorHttp(409, "Una pieza no se divide: se mueve completa. Tomar una parte de ella es un corte parcial y se registra como salida.");
      }

      let destinoId = d.data.destinoId;
      if (d.data.destinoCodigo) destinoId = await ubicacionDeCodigo(tx, d.data.destinoCodigo);
      const destino = await tx.ubicacion.findUnique({ where: { id: destinoId! }, include: { zona: true, bodega: true } });
      if (!destino) throw new ErrorHttp(404, "Ubicación no encontrada.");
      if (destino.id === origen.ubicacionId) throw new ErrorHttp(422, "El destino es la misma ubicación de origen: el movimiento no tendría efecto.");
      // La zona de recepción es para lo recién llegado (RN-EXI-007): lo que ya está disponible no vuelve allí.
      if (destino.zona.tipo === "RECEPCION") throw new ErrorHttp(409, "La zona de recepción es para mercancía recién llegada: elija una ubicación de almacenamiento.");
      const origenUbicacion = await tx.ubicacion.findUniqueOrThrow({ where: { id: origen.ubicacionId } });
      const ref = pieza.linea.sku.referencia;
      const ctx: ContextoPieza = { cantidad: origen.cantidad, referenciaId: ref.id, categoriaId: ref.categoriaId, unidad: ref.unidadMedida, bodegaId: origenUbicacion.bodegaId };
      const rechazo = await errorDeDestino(tx, destino, ctx);
      if (rechazo) throw new ErrorHttp(409, rechazo);

      const ahora = new Date();
      const inicio = d.data.iniciadoEn ? new Date(d.data.iniciadoEn) : ahora;
      const modo: ModoIdentificacion = d.data.mercanciaCodigo && d.data.destinoCodigo ? "ESCANEO" : "MANUAL";
      const mov = await tx.movimiento.create({
        data: {
          tipo: "MOVIMIENTO_INTERNO", usuarioId: req.user.id, usuarioLogin: req.user.login,
          iniciadoEn: inicio.getTime() > ahora.getTime() ? ahora : inicio, confirmadoEn: ahora, modoIdentificacion: modo,
          asientos: { create: [
            { piezaId: pieza.id, ubicacionId: origen.ubicacionId, estado: "DISPONIBLE", delta: -origen.cantidad },
            { piezaId: pieza.id, ubicacionId: destino.id, estado: "DISPONIBLE", delta: origen.cantidad },
          ] },
        },
      });
      await registrar(tx, { actor: actor(req), modulo: "MOVIMIENTOS", evento: "movimiento_interno", entidad: "Movimiento", entidadId: mov.id, detalle: { pieza: pieza.numero, cantidad: origen.cantidad, origen: origen.ubicacion, destino: destino.codigo, modo }, origen: req.ip });
      return { movimientoId: mov.id, secuencia: mov.secuencia, pieza: pieza.numero, cantidad: origen.cantidad, origen: origen.ubicacion, destino: destino.codigo, modo };
    });
    return reply.code(201).send(resultado);
  }));
};
