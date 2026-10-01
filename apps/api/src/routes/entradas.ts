import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { TIPOS_PIEZA, type DesviacionVista, type DocumentoEntradaResumen, type DocumentoEntradaVista, type LineaEntradaVista, type PiezaVista, type PropuestaUbicacion } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar } from "../bitacora.js";
import { aMilesimas, errorDeCantidad, errorDeDestino, numero, proponerUbicacion, recepcionCerrada, resultadoLinea, tipoCompatible, ubicacionDeRecepcion, type ContextoPieza } from "../entradas.js";
import { existenciaDePiezas } from "../inventario.js";
import { requiereRol } from "../permisos.js";
import { skuVista } from "./lotes.js";

// Matriz de permisos (SRS §3.3): crear el documento = Admin, Jefe y Coordinador; registrar la recepción y ubicar = además el Auxiliar;
// confirmar = Admin, Jefe y Coordinador (nunca quien recibió); autorizar un sobrante = Jefe (RF-ENT-009) y el Administrador.
const crea = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA");
const opera = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA", "AUXILIAR_BODEGA");
const autoriza = requiereRol("ADMINISTRADOR", "JEFE_BODEGA");

class ErrorHttp extends Error {
  constructor(public estado: number, mensaje: string, public extra: object = {}) { super(mensaje); }
}
type Manejador = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/** Los rechazos de negocio se lanzan como ErrorHttp desde dentro de las transacciones, para que deshagan todo lo hecho. */
const manejar = (f: Manejador): Manejador => async (req, reply) => {
  try { return await f(req, reply); }
  catch (e) {
    if (e instanceof ErrorHttp) return reply.code(e.estado).send({ error: e.message, ...e.extra });
    if (e instanceof Error && e.message.includes("(RN-EXI-001)")) return reply.code(409).send({ error: "La existencia no puede quedar por debajo de cero." });
    throw e;
  }
};

const id = z.string().min(1);
const crearDocumento = z.object({
  bodegaId: id,
  origen: z.string().trim().min(2, "Indique el origen.").max(120),
  fechaEsperada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha esperada debe tener la forma AAAA-MM-DD."),
  // DC-03 / RF-ENT-002: ni precio, ni condiciones comerciales, ni orden de compra.
  lineas: z.array(z.object({ skuId: id, cantidad: z.number() })).min(1, "Agregue al menos una línea.").max(100),
  confirmarDuplicado: z.boolean().default(false),
});
const registrarPieza = z.object({ lineaId: id, tipo: z.enum(TIPOS_PIEZA), cantidad: z.number() });
const confirmar = z.object({
  lotes: z.array(z.object({ lineaId: id, loteId: id.optional(), codigo: z.string().trim().min(1).max(40).transform((c) => c.toUpperCase()).optional(), origen: z.string().trim().min(2).max(120).optional() })).default([]),
});
const ubicar = z.object({
  destinoCodigo: z.string().trim().min(1).max(60).optional(),
  destinoId: id.optional(),
  mercanciaCodigo: z.string().trim().min(1).max(60).optional(),
  iniciadoEn: z.string().datetime().optional(),
});

const incluirDocumento = {
  bodega: true,
  lineas: {
    orderBy: [{ sku: { referencia: { codigo: "asc" } } }, { sku: { talla: { nombre: "asc" } } }, { sku: { color: { nombre: "asc" } } }],
    include: {
      sku: { include: { referencia: { include: { categoria: true } }, talla: true, color: true } },
      lote: true,
      piezas: { orderBy: { numero: "asc" } },
    },
  },
} satisfies Prisma.DocumentoEntradaInclude;
type Documento = Prisma.DocumentoEntradaGetPayload<{ include: typeof incluirDocumento }>;
type Cliente = Prisma.TransactionClient | typeof prisma;

const cargar = (docId: string, c: Cliente = prisma) => c.documentoEntrada.findUnique({ where: { id: docId }, include: incluirDocumento });
const recibidoDe = (l: Documento["lineas"][number]) => l.piezas.reduce((t, p) => t + aMilesimas(numero(p.cantidad)), 0) / 1000;
const iso = (d: Date) => d.toISOString();

function resumen(d: Documento): DocumentoEntradaResumen {
  const cerrada = recepcionCerrada(d.estado);
  const resultados = d.lineas.map((l) => resultadoLinea(numero(l.cantidadEsperada), recibidoDe(l), cerrada));
  return {
    id: d.id, numero: d.numero, origen: d.origen, fechaEsperada: d.fechaEsperada.toISOString().slice(0, 10), estado: d.estado, bodega: d.bodega.codigo,
    lineas: d.lineas.length, creadoEn: iso(d.creadoEn), tieneFaltante: resultados.includes("FALTANTE"), tieneSobrante: resultados.includes("SOBRANTE"),
  };
}

async function vista(d: Documento): Promise<DocumentoEntradaVista> {
  const piezas = d.lineas.flatMap((l) => l.piezas);
  const ids = [...new Set([d.creadoPorId, d.sobranteAutorizadoPorId, d.confirmadoPorId, ...piezas.map((p) => p.registradaPorId)].filter((x): x is string => !!x))];
  const logins = new Map((await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, login: true } })).map((u) => [u.id, u.login]));
  const login = (x: string) => logins.get(x) ?? "(desconocido)";
  const donde = await existenciaDePiezas(piezas.map((p) => p.id));
  const cerrada = recepcionCerrada(d.estado);

  const detalle: LineaEntradaVista[] = d.lineas.map((l) => {
    const recibida = recibidoDe(l);
    return {
      id: l.id, sku: skuVista(l.sku), cantidadEsperada: numero(l.cantidadEsperada), cantidadRecibida: recibida,
      diferencia: l.diferencia === null ? null : numero(l.diferencia),
      resultado: resultadoLinea(numero(l.cantidadEsperada), recibida, cerrada),
      lote: l.lote ? { id: l.lote.id, codigo: l.lote.codigo } : null,
      piezas: l.piezas.map((p): PiezaVista => ({ id: p.id, numero: p.numero, tipo: p.tipo, cantidad: numero(p.cantidad), registradaPor: login(p.registradaPorId), registradaEn: iso(p.registradaEn), ubicaciones: donde.get(p.id) ?? [] })),
    };
  });
  const ubicacionRecepcion = d.ubicacionRecepcionId ? (await prisma.ubicacion.findUnique({ where: { id: d.ubicacionRecepcionId } }))?.codigo ?? null : null;
  const receptores = [...new Set(piezas.slice().sort((a, b) => a.registradaEn.getTime() - b.registradaEn.getTime()).map((p) => login(p.registradaPorId)))];
  return {
    ...resumen(d), bodegaId: d.bodegaId, creadoPor: login(d.creadoPorId), llegadaEn: d.llegadaEn ? iso(d.llegadaEn) : null, receptores,
    sobranteAutorizado: d.sobranteAutorizadoPorId && d.sobranteAutorizadoEn ? { por: login(d.sobranteAutorizadoPorId), en: iso(d.sobranteAutorizadoEn) } : null,
    confirmado: d.confirmadoPorId && d.confirmadoEn ? { por: login(d.confirmadoPorId), en: iso(d.confirmadoEn) } : null,
    ubicacionRecepcion, detalle,
  };
}

const bloquear = (tx: Prisma.TransactionClient, docId: string) => tx.$queryRaw`SELECT id FROM "DocumentoEntrada" WHERE id = ${docId} FOR UPDATE`;

export const rutasEntradas: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: FastifyRequest) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });
  const documentoOError = async (docId: string, c: Cliente = prisma) => (await cargar(docId, c)) ?? Promise.reject(new ErrorHttp(404, "Documento de entrada no encontrado."));

  app.get("/", async (req): Promise<DocumentoEntradaResumen[]> => {
    const { estado } = req.query as { estado?: string };
    const docs = await prisma.documentoEntrada.findMany({ where: estado ? { estado: estado as Documento["estado"] } : {}, include: incluirDocumento, orderBy: { numero: "desc" }, take: 200 });
    return docs.map(resumen);
  });

  /** RN-MOV-003 / RF-BOD-009: el Coordinador ve dónde se desvió la ubicación respecto a la propuesta (información operativa, no una falta). */
  app.get("/desviaciones", { preHandler: crea }, async (): Promise<DesviacionVista[]> => {
    const movs = await prisma.movimiento.findMany({ where: { desviacion: true }, orderBy: { secuencia: "desc" }, take: 100, include: { documentoEntrada: true, asientos: { include: { ubicacion: true, pieza: true } } } });
    const propuestas = new Map((await prisma.ubicacion.findMany({ where: { id: { in: movs.map((m) => m.propuestaUbicacionId).filter((x): x is string => !!x) } } })).map((u) => [u.id, u.codigo]));
    return movs.map((m) => {
      const entra = m.asientos.find((a) => numero(a.delta) > 0)!;
      return { movimientoId: m.id, instante: iso(m.confirmadoEn), usuario: m.usuarioLogin, documento: m.documentoEntrada?.numero ?? 0, pieza: entra.pieza.numero, propuesta: m.propuestaUbicacionId ? propuestas.get(m.propuestaUbicacionId) ?? null : null, elegida: entra.ubicacion.codigo };
    });
  });

  app.get("/:id", manejar(async (req) => vista(await documentoOError((req.params as { id: string }).id))));

  /** HU-ENT-001: documento con lo esperado, pendiente de recepción; advierte de posible duplicado y exige confirmación (RN-ENT-002). */
  app.post("/", { preHandler: crea }, manejar(async (req, reply) => {
    const d = crearDocumento.safeParse(req.body);
    if (!d.success) throw new ErrorHttp(422, d.error.issues[0]?.message ?? "Datos no válidos.");
    const skuIds = d.data.lineas.map((l) => l.skuId);
    if (new Set(skuIds).size !== skuIds.length) throw new ErrorHttp(422, "Un SKU solo puede aparecer en una línea.");
    if (!(await prisma.bodega.findUnique({ where: { id: d.data.bodegaId } }))) throw new ErrorHttp(404, "Bodega no encontrada.");
    const skus = await prisma.sku.findMany({ where: { id: { in: skuIds } }, include: { referencia: true } });
    if (skus.length !== skuIds.length) throw new ErrorHttp(404, "Algún SKU no existe.");
    // RN-ENT-001: solo referencias activas.
    const inactiva = skus.find((s) => !s.referencia.activa);
    if (inactiva) throw new ErrorHttp(422, `La referencia ${inactiva.referencia.codigo} está desactivada: no se puede recibir.`);
    for (const l of d.data.lineas) {
      const sku = skus.find((s) => s.id === l.skuId)!;
      const error = errorDeCantidad(sku.referencia.unidadMedida, l.cantidad);
      if (error) throw new ErrorHttp(422, `${sku.referencia.codigo}: ${error}`);
    }
    const fecha = new Date(`${d.data.fechaEsperada}T00:00:00.000Z`);
    if (Number.isNaN(fecha.getTime())) throw new ErrorHttp(422, "La fecha esperada no es válida.");

    const duplicados = await prisma.documentoEntrada.findMany({
      where: { origen: { equals: d.data.origen, mode: "insensitive" }, fechaEsperada: fecha, lineas: { some: { sku: { referenciaId: { in: skus.map((s) => s.referenciaId) } } } } },
      select: { id: true, numero: true },
    });
    if (duplicados.length > 0 && !d.data.confirmarDuplicado) {
      throw new ErrorHttp(409, "Ya existe un documento con el mismo origen, referencia y fecha. Confirme si es otra remesa.", { codigo: "POSIBLE_DUPLICADO", duplicados });
    }

    const creado = await prisma.$transaction(async (tx) => {
      const doc = await tx.documentoEntrada.create({
        data: {
          bodegaId: d.data.bodegaId, origen: d.data.origen, fechaEsperada: fecha, creadoPorId: req.user.id,
          lineas: { create: d.data.lineas.map((l) => ({ skuId: l.skuId, cantidadEsperada: l.cantidad })) },
        },
      });
      await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "entrada_creada", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { numero: doc.numero, origen: doc.origen, lineas: d.data.lineas.length, duplicadoConfirmado: duplicados.length > 0 }, origen: req.ip });
      return doc.id;
    });
    return reply.code(201).send(await vista(await documentoOError(creado)));
  }));

  /**
   * HU-ENT-002 / HU-ENT-009: el Auxiliar registra cada pieza recibida con su tipo y su cantidad propia. La cantidad recibida de la
   * línea es la suma de sus piezas (RN-LOT-007) y se compara con la esperada (RN-ENT-003). Si todo coincide, el documento queda conforme.
   */
  app.post("/:id/piezas", { preHandler: opera }, manejar(async (req, reply) => {
    const docId = (req.params as { id: string }).id;
    const d = registrarPieza.safeParse(req.body);
    if (!d.success) throw new ErrorHttp(422, "Indique la línea, el tipo de pieza y su cantidad.");
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, docId);
      const doc = await documentoOError(docId, tx);
      if (doc.estado !== "PENDIENTE_RECEPCION" && doc.estado !== "RECEPCION_PARCIAL") throw new ErrorHttp(409, "La recepción de este documento ya está cerrada.");
      const linea = doc.lineas.find((l) => l.id === d.data.lineaId);
      if (!linea) throw new ErrorHttp(404, "La línea no pertenece a este documento.");
      const unidad = linea.sku.referencia.unidadMedida;
      const errorCantidad = errorDeCantidad(unidad, d.data.cantidad);
      if (errorCantidad) throw new ErrorHttp(422, errorCantidad);
      // F-1: rollo para metros, kilogramos o rollos; paquete o bolsa para unidades.
      if (!tipoCompatible(unidad, d.data.tipo)) throw new ErrorHttp(422, `Una referencia en ${unidad.toLowerCase()} se recibe en ${unidad === "UNIDADES" ? "paquete o bolsa" : "rollo"}.`);

      const otrosReceptores = new Set(doc.lineas.flatMap((l) => l.piezas.map((p) => p.registradaPorId)));
      const antes = recibidoDe(linea);
      const pieza = await tx.pieza.create({ data: { lineaId: linea.id, tipo: d.data.tipo, cantidad: d.data.cantidad, registradaPorId: req.user.id } });
      const despues = (aMilesimas(antes) + aMilesimas(d.data.cantidad)) / 1000;
      const ref = linea.sku.referencia.codigo;

      await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "pieza_registrada", entidad: "Pieza", entidadId: pieza.id, detalle: { documento: doc.numero, pieza: pieza.numero, referencia: ref, tipo: pieza.tipo, cantidad: d.data.cantidad }, origen: req.ip });
      // RF-ENT-006: la recepción puede continuarla otro usuario; quedan registrados ambos.
      if (otrosReceptores.size > 0 && !otrosReceptores.has(req.user.id)) {
        await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "recepcion_continuada_por_otro_usuario", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { documento: doc.numero, anteriores: otrosReceptores.size }, origen: req.ip });
      }
      // HU-ENT-004 criterio 3: el sobrante se marca en el momento.
      if (aMilesimas(antes) <= aMilesimas(numero(linea.cantidadEsperada)) && aMilesimas(despues) > aMilesimas(numero(linea.cantidadEsperada))) {
        await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "sobrante_detectado", entidad: "LineaEntrada", entidadId: linea.id, detalle: { documento: doc.numero, referencia: ref, esperada: numero(linea.cantidadEsperada), recibida: despues }, origen: req.ip });
      }

      // RF-ENT-017: instante de llegada; estado: parcial, o conforme si todas las líneas coinciden.
      const conforme = doc.lineas.every((l) => aMilesimas(l.id === linea.id ? despues : recibidoDe(l)) === aMilesimas(numero(l.cantidadEsperada)));
      await tx.documentoEntrada.update({ where: { id: doc.id }, data: { llegadaEn: doc.llegadaEn ?? new Date(), estado: conforme ? "RECIBIDO_CONFORME" : "RECEPCION_PARCIAL" } });
      if (conforme) {
        for (const l of doc.lineas) await tx.lineaEntrada.update({ where: { id: l.id }, data: { diferencia: 0 } });
        await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "recepcion_conforme", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { documento: doc.numero }, origen: req.ip });
      }
    });
    return reply.code(201).send(await vista(await documentoOError(docId)));
  }));

  /**
   * Cierra la recepción: desde aquí un faltante es definitivo. Registra la diferencia de cada línea en el documento (HU-ENT-004 criterio 5).
   * Faltante: el documento queda «recibido con novedad» y el hecho queda en la bitácora para el Jefe (RN-ENT-004); no bloquea confirmar lo recibido.
   */
  app.post("/:id/cerrar-recepcion", { preHandler: opera }, manejar(async (req) => {
    const docId = (req.params as { id: string }).id;
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, docId);
      const doc = await documentoOError(docId, tx);
      if (doc.estado !== "PENDIENTE_RECEPCION" && doc.estado !== "RECEPCION_PARCIAL") throw new ErrorHttp(409, "La recepción de este documento ya está cerrada.");
      let hayNovedad = false;
      for (const l of doc.lineas) {
        const recibida = recibidoDe(l);
        const dif = (aMilesimas(recibida) - aMilesimas(numero(l.cantidadEsperada))) / 1000;
        await tx.lineaEntrada.update({ where: { id: l.id }, data: { diferencia: dif } });
        if (dif !== 0) {
          hayNovedad = true;
          await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: dif < 0 ? "faltante_recepcion" : "sobrante_recepcion", entidad: "LineaEntrada", entidadId: l.id, detalle: { documento: doc.numero, referencia: l.sku.referencia.codigo, esperada: numero(l.cantidadEsperada), recibida, diferencia: dif }, origen: req.ip });
        }
      }
      await tx.documentoEntrada.update({ where: { id: doc.id }, data: { estado: hayNovedad ? "RECIBIDO_CON_NOVEDAD" : "RECIBIDO_CONFORME" } });
      await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "recepcion_cerrada", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { documento: doc.numero, conNovedad: hayNovedad }, origen: req.ip });
    });
    return vista(await documentoOError(docId));
  }));

  /** RN-ENT-005 / RF-ENT-009: el sobrante lo autoriza el Jefe antes de confirmar; sin autorización no ingresa al inventario. */
  app.post("/:id/autorizar-sobrante", { preHandler: autoriza }, manejar(async (req) => {
    const docId = (req.params as { id: string }).id;
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, docId);
      const doc = await documentoOError(docId, tx);
      if (doc.estado !== "RECIBIDO_CON_NOVEDAD") throw new ErrorHttp(409, "Solo se autoriza el sobrante de un documento recibido con novedad.");
      if (!doc.lineas.some((l) => resultadoLinea(numero(l.cantidadEsperada), recibidoDe(l), true) === "SOBRANTE")) throw new ErrorHttp(409, "Este documento no tiene sobrante que autorizar.");
      if (doc.sobranteAutorizadoPorId) throw new ErrorHttp(409, "El sobrante ya fue autorizado.");
      await tx.documentoEntrada.update({ where: { id: doc.id }, data: { sobranteAutorizadoPorId: req.user.id, sobranteAutorizadoEn: new Date() } });
      await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "sobrante_autorizado", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { documento: doc.numero }, origen: req.ip });
    });
    return vista(await documentoOError(docId));
  }));

  /**
   * HU-ENT-003: una segunda persona confirma. Asocia o crea el lote de cada línea (HU-LOT-001), genera el movimiento de entrada en el kardex
   * y la existencia queda EN RECEPCION, no disponible, hasta ubicarse (RN-EXI-007). Una entrada confirmada no se edita (RN-INT-002).
   */
  app.post("/:id/confirmar", { preHandler: crea }, manejar(async (req) => {
    const docId = (req.params as { id: string }).id;
    const d = confirmar.safeParse(req.body ?? {});
    if (!d.success) throw new ErrorHttp(422, "Datos de lote no válidos.");
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, docId);
      const doc = await documentoOError(docId, tx);
      if (doc.estado === "CONFIRMADO") throw new ErrorHttp(409, "La entrada ya está confirmada y no puede editarse; un error se corrige con un movimiento inverso.");
      if (!recepcionCerrada(doc.estado)) throw new ErrorHttp(409, "Cierre la recepción antes de confirmar la entrada.");
      const piezas = doc.lineas.flatMap((l) => l.piezas);
      if (piezas.length === 0) throw new ErrorHttp(409, "No hay piezas recibidas que confirmar.");
      // RN-ENT-007 / PR-01: quien registró la recepción física no confirma la misma entrada.
      if (piezas.some((p) => p.registradaPorId === req.user.id)) throw new ErrorHttp(409, "Quien registró la recepción física no puede confirmar la misma entrada: la confirma otra persona.");
      // RN-ENT-005: un sobrante no autorizado no ingresa al inventario.
      const haySobrante = doc.lineas.some((l) => resultadoLinea(numero(l.cantidadEsperada), recibidoDe(l), true) === "SOBRANTE");
      if (haySobrante && !doc.sobranteAutorizadoPorId) throw new ErrorHttp(409, "El documento tiene sobrante: el Jefe de Bodega debe autorizarlo antes de confirmar.");
      const recepcion = await ubicacionDeRecepcion(tx, doc.bodegaId);
      if (!recepcion) throw new ErrorHttp(409, "La bodega no tiene una ubicación de recepción activa.");

      // HU-LOT-001 criterios 1 y 4: toda línea con mercancía queda asociada a un lote, creado o existente.
      const confirmadas = doc.lineas.filter((l) => l.piezas.length > 0);
      for (const l of confirmadas) {
        const eleccion = d.data.lotes.find((x) => x.lineaId === l.id);
        if (!eleccion || (!eleccion.loteId && !eleccion.codigo)) throw new ErrorHttp(422, `Indique el lote de ${l.sku.referencia.codigo} (${l.sku.talla.nombre}, ${l.sku.color.nombre}).`);
        let lote;
        if (eleccion.loteId) {
          lote = await tx.lote.findUnique({ where: { id: eleccion.loteId } });
          if (!lote || lote.skuId !== l.skuId) throw new ErrorHttp(422, `El lote elegido no es de ${l.sku.referencia.codigo} (${l.sku.talla.nombre}, ${l.sku.color.nombre}).`);
        } else {
          lote = await tx.lote.findUnique({ where: { skuId_codigo: { skuId: l.skuId, codigo: eleccion.codigo! } } });
          if (!lote) {
            lote = await tx.lote.create({ data: { skuId: l.skuId, codigo: eleccion.codigo!, origen: eleccion.origen ?? doc.origen } });
            await registrar(tx, { actor: actor(req), modulo: "LOTES", evento: "lote_creado", entidad: "Lote", entidadId: lote.id, detalle: { codigo: lote.codigo, skuId: l.skuId, referencia: l.sku.referencia.codigo, origen: lote.origen, documento: doc.numero }, origen: req.ip });
          }
        }
        await tx.lineaEntrada.update({ where: { id: l.id }, data: { loteId: lote.id } });
      }

      const ahora = new Date();
      await tx.documentoEntrada.update({ where: { id: doc.id }, data: { estado: "CONFIRMADO", confirmadoPorId: req.user.id, confirmadoEn: ahora, ubicacionRecepcionId: recepcion.id } });
      // RF-ENT-011 / RN-INT-004: un movimiento de entrada con un asiento por pieza; la existencia se deriva de ellos.
      const mov = await tx.movimiento.create({
        data: {
          tipo: "ENTRADA", documentoEntradaId: doc.id, usuarioId: req.user.id, usuarioLogin: req.user.login,
          iniciadoEn: doc.llegadaEn ?? ahora, confirmadoEn: ahora,
          asientos: { create: piezas.map((p) => ({ piezaId: p.id, ubicacionId: recepcion.id, estado: "EN_RECEPCION" as const, delta: p.cantidad })) },
        },
      });
      await registrar(tx, { actor: actor(req), modulo: "ENTRADAS", evento: "entrada_confirmada", entidad: "DocumentoEntrada", entidadId: doc.id, detalle: { documento: doc.numero, movimientoId: mov.id, piezas: piezas.length, ubicacionRecepcion: recepcion.codigo, conSobranteAutorizado: haySobrante }, origen: req.ip });
    });
    return vista(await documentoOError(docId));
  }));

  /** Lo que el sistema propone para ubicar esta pieza (HU-ENT-006 criterio 1). Leer no escribe. */
  app.get("/piezas/:piezaId/propuesta", manejar(async (req): Promise<PropuestaUbicacion> => {
    const { pieza, contexto } = await cargarPieza((req.params as { piezaId: string }).piezaId);
    return proponerUbicacion(prisma, contexto(pieza.cantidad));
  }));

  /**
   * HU-ENT-006: la primera ubicación es un movimiento interno desde la recepción hacia el destino (RN-MOV-010). El Auxiliar confirma
   * escaneando la mercancía y luego la ubicación; si elige otra que la propuesta, se permite y se registra la desviación (RN-MOV-003).
   * La pieza no se divide (HD-29): se ubica completa.
   */
  app.post("/piezas/:piezaId/ubicar", { preHandler: opera }, manejar(async (req, reply) => {
    const piezaId = (req.params as { piezaId: string }).piezaId;
    const d = ubicar.safeParse(req.body);
    if (!d.success || (!d.data.destinoCodigo && !d.data.destinoId)) throw new ErrorHttp(422, "Indique la ubicación destino: escanee su QR o selecciónela.");
    const resultado = await prisma.$transaction(async (tx) => {
      const { pieza, contexto, documento } = await cargarPieza(piezaId, tx);
      if (documento.estado !== "CONFIRMADO") throw new ErrorHttp(409, "La pieza se ubica cuando la entrada está confirmada.");
      const donde = (await existenciaDePiezas([pieza.id], tx)).get(pieza.id) ?? [];
      const origen = donde.find((x) => x.estado === "EN_RECEPCION");
      if (!origen) throw new ErrorHttp(409, "La pieza ya está ubicada. Moverla de nuevo es un movimiento interno.");

      // Escaneo de la mercancía (QR de SKU + Lote): debe ser el de esta pieza.
      if (d.data.mercanciaCodigo) {
        const ident = await tx.identificador.findUnique({ where: { codigo: d.data.mercanciaCodigo.toUpperCase() } });
        if (!ident || ident.tipo !== "MERCANCIA") throw new ErrorHttp(409, "El código de mercancía no está registrado.");
        if (ident.estado === "ANULADO") throw new ErrorHttp(409, "El identificador de la mercancía está anulado.");
        if (ident.loteId !== pieza.linea.loteId) throw new ErrorHttp(409, "La mercancía escaneada no corresponde a esta pieza (otro SKU o lote).");
      }
      // Destino: por QR de ubicación o por selección.
      let destinoId = d.data.destinoId;
      if (d.data.destinoCodigo) {
        const ident = await tx.identificador.findUnique({ where: { codigo: d.data.destinoCodigo.toUpperCase() } });
        if (!ident || ident.tipo !== "UBICACION" || !ident.ubicacionId) throw new ErrorHttp(409, "El código escaneado no es el de una ubicación.");
        if (ident.estado === "ANULADO") throw new ErrorHttp(409, "El identificador de la ubicación está anulado.");
        destinoId = ident.ubicacionId;
      }
      const destino = await tx.ubicacion.findUnique({ where: { id: destinoId! }, include: { zona: true, bodega: true } });
      if (!destino) throw new ErrorHttp(404, "Ubicación no encontrada.");
      if (destino.id === origen.ubicacionId) throw new ErrorHttp(422, "El destino es la misma ubicación donde está la pieza.");
      const ctx = contexto(origen.cantidad);
      const rechazo = await errorDeDestino(tx, destino, ctx);
      if (rechazo) throw new ErrorHttp(409, rechazo);

      const propuesta = await proponerUbicacion(tx, ctx);
      const desviacion = propuesta.ubicacion.id !== destino.id;
      const ahora = new Date();
      const inicio = d.data.iniciadoEn ? new Date(d.data.iniciadoEn) : ahora;
      const estadoDestino = destino.zona.tipo === "RECEPCION" ? "EN_RECEPCION" : "DISPONIBLE";
      const modo = d.data.mercanciaCodigo && d.data.destinoCodigo ? "ESCANEO" : "MANUAL";
      // RN-MOV-010 / RN-MOV-004: un movimiento interno; el descuento en origen y el incremento en destino son indivisibles (misma transacción).
      const mov = await tx.movimiento.create({
        data: {
          tipo: "MOVIMIENTO_INTERNO", documentoEntradaId: documento.id, usuarioId: req.user.id, usuarioLogin: req.user.login,
          iniciadoEn: inicio.getTime() > ahora.getTime() ? ahora : inicio, confirmadoEn: ahora, modoIdentificacion: modo,
          propuestaUbicacionId: propuesta.ubicacion.id, desviacion,
          asientos: { create: [
            { piezaId: pieza.id, ubicacionId: origen.ubicacionId, estado: "EN_RECEPCION", delta: -origen.cantidad },
            { piezaId: pieza.id, ubicacionId: destino.id, estado: estadoDestino, delta: origen.cantidad },
          ] },
        },
      });
      await registrar(tx, { actor: actor(req), modulo: "MOVIMIENTOS", evento: "pieza_ubicada", entidad: "Movimiento", entidadId: mov.id, detalle: { documento: documento.numero, pieza: pieza.numero, cantidad: origen.cantidad, origen: origen.ubicacion, destino: destino.codigo, estado: estadoDestino, modo }, origen: req.ip });
      if (desviacion) {
        // RN-MOV-003: información operativa para el Coordinador, no una falta imputable al Auxiliar.
        await registrar(tx, { actor: actor(req), modulo: "MOVIMIENTOS", evento: "ubicacion_desviada", entidad: "Movimiento", entidadId: mov.id, detalle: { documento: documento.numero, pieza: pieza.numero, propuesta: propuesta.ubicacion.codigo, elegida: destino.codigo }, origen: req.ip });
      }
      return { movimientoId: mov.id, desviacion, propuesta, destino: destino.codigo, estado: estadoDestino as "EN_RECEPCION" | "DISPONIBLE", modo: modo as "ESCANEO" | "MANUAL" };
    });
    return reply.code(201).send(resultado);
  }));

  /** Pieza con lo necesario para proponer y validar: su cantidad en recepción y el contexto de su referencia. */
  async function cargarPieza(piezaId: string, c: Cliente = prisma) {
    const pieza = await c.pieza.findUnique({ where: { id: piezaId }, include: { linea: { include: { sku: { include: { referencia: true } }, documento: true } } } });
    if (!pieza) throw new ErrorHttp(404, "Pieza no encontrada.");
    const documento = pieza.linea.documento;
    const ref = pieza.linea.sku.referencia;
    const contexto = (cantidad: number): ContextoPieza => ({ cantidad, referenciaId: ref.id, categoriaId: ref.categoriaId, unidad: ref.unidadMedida, bodegaId: documento.bodegaId });
    return { pieza: { ...pieza, cantidad: numero(pieza.cantidad) }, documento, contexto };
  }
};
