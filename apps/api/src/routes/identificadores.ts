import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { EtiquetaVista, IdentificadorResumen, ResolucionVista } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar, registrarSuelto } from "../bitacora.js";
import { asegurarIdentificadorUbicacion, crearIdentificadorMercancia, etiquetasDe } from "../identificadores.js";
import { ubicacionesConExistencia } from "../inventario.js";
import { requiereRol } from "../permisos.js";
import { skuVista } from "./lotes.js";

// Matriz de permisos: generar e imprimir QR de mercancía = Administrador, Jefe y Coordinador; el de ubicaciones, solo el Administrador (HU-QRC-003).
const generaMercancia = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA");
const soloAdmin = requiereRol("ADMINISTRADOR");

const desdeLote = z.object({ loteId: z.string().min(1) });
const desdeUbicaciones = z.object({ ubicacionIds: z.array(z.string().min(1)).min(1).max(500).optional(), zonaId: z.string().min(1).optional() })
  .refine((d) => (d.ubicacionIds === undefined) !== (d.zonaId === undefined), "Indique las ubicaciones o una zona completa, no ambas.");
const resolver = z.object({ codigo: z.string().trim().min(1).max(60), modo: z.enum(["ESCANEO", "MANUAL"]).default("ESCANEO") });

const resumen = (i: { id: string; codigo: string; tipo: IdentificadorResumen["tipo"]; estado: IdentificadorResumen["estado"]; loteId: string | null; ubicacionId: string | null }): IdentificadorResumen =>
  ({ id: i.id, codigo: i.codigo, tipo: i.tipo, estado: i.estado, loteId: i.loteId, ubicacionId: i.ubicacionId });

export const rutasIdentificadores: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });

  app.get("/", { preHandler: generaMercancia }, async (req): Promise<IdentificadorResumen[]> => {
    const { tipo } = req.query as { tipo?: string };
    const where = tipo === "MERCANCIA" ? { tipo: "MERCANCIA" as const } : tipo === "UBICACION" ? { tipo: "UBICACION" as const } : {};
    return (await prisma.identificador.findMany({ where, orderBy: { creadoEn: "desc" }, take: 1000 })).map(resumen);
  });

  /** HU-QRC-001 criterios 1 y 4: un identificador único por SKU + Lote, activo al nacer. */
  app.post("/mercancia", { preHandler: generaMercancia }, async (req, reply) => {
    const d = desdeLote.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: "Indique el lote." });
    const lote = await prisma.lote.findUnique({ where: { id: d.data.loteId }, include: { identificador: true } });
    if (!lote) return reply.code(404).send({ error: "Lote no encontrado." });
    if (lote.identificador) return reply.code(409).send({ error: "Ese lote ya tiene su identificador QR; imprímalo de nuevo, no se genera otro." });
    const id = await prisma.$transaction(async (tx) => {
      const nuevo = await crearIdentificadorMercancia(tx, lote.id);
      await registrar(tx, { actor: actor(req), modulo: "IDENTIFICACION", evento: "identificador_generado", entidad: "Identificador", entidadId: nuevo.id, detalle: { codigo: nuevo.codigo, tipo: nuevo.tipo, loteId: lote.id }, origen: req.ip });
      return nuevo;
    });
    return reply.code(201).send(resumen(id));
  });

  /** HU-QRC-003 criterios 1 y 2: cada ubicación tiene su identificador; se piden por ubicación o por zona completa. Idempotente. */
  app.post("/ubicaciones", { preHandler: soloAdmin }, async (req, reply) => {
    const d = desdeUbicaciones.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: d.error.issues[0]?.message ?? "Datos no válidos." });
    const ubicaciones = await prisma.ubicacion.findMany({
      where: d.data.zonaId ? { zonaId: d.data.zonaId, activa: true } : { id: { in: d.data.ubicacionIds } },
      orderBy: { codigo: "asc" },
    });
    if (d.data.ubicacionIds && ubicaciones.length !== new Set(d.data.ubicacionIds).size) return reply.code(404).send({ error: "Alguna ubicación no existe." });
    if (ubicaciones.length === 0) return reply.code(404).send({ error: "La zona no existe o no tiene ubicaciones activas." });
    const resultado = await prisma.$transaction(async (tx) => {
      const salida: IdentificadorResumen[] = [];
      let nuevos = 0;
      for (const u of ubicaciones) {
        const { identificador, nuevo } = await asegurarIdentificadorUbicacion(tx, u.id);
        if (nuevo) {
          nuevos++;
          await registrar(tx, { actor: actor(req), modulo: "IDENTIFICACION", evento: "identificador_generado", entidad: "Identificador", entidadId: identificador.id, detalle: { codigo: identificador.codigo, tipo: identificador.tipo, ubicacionId: u.id }, origen: req.ip });
        }
        salida.push(resumen(identificador));
      }
      return { identificadores: salida, nuevos };
    });
    return reply.code(201).send(resultado);
  });

  /** HU-QRC-001 criterios 2 y 3: impresión individual o por lote de impresión, con información legible de respaldo. */
  app.get("/etiquetas", { preHandler: generaMercancia }, async (req, reply): Promise<EtiquetaVista[] | void> => {
    const ids = [...new Set(String((req.query as { ids?: string }).ids ?? "").split(",").map((i) => i.trim()).filter(Boolean))];
    if (ids.length === 0) return reply.code(422).send({ error: "Indique qué identificadores imprimir." });
    if (ids.length > 200) return reply.code(422).send({ error: "Máximo 200 etiquetas por impresión." });
    const etiquetas = await etiquetasDe(ids);
    if (etiquetas.length !== ids.length) return reply.code(404).send({ error: "Algún identificador no existe." });
    if (req.user.rol !== "ADMINISTRADOR" && etiquetas.some((e) => e.tipo === "UBICACION")) return reply.code(403).send({ error: "Solo el Administrador imprime identificadores de ubicación." });
    return etiquetas;
  });

  /** HU-QRC-002: resuelve un identificador escaneado (o digitado) a su SKU + Lote y a las ubicaciones con existencia. */
  app.post("/resolver", async (req, reply): Promise<ResolucionVista | void> => {
    const d = resolver.safeParse(req.body);
    if (!d.success) return reply.code(422).send({ error: "No se recibió ningún código." });
    const codigo = d.data.codigo.toUpperCase();
    const fila = await prisma.identificador.findUnique({
      where: { codigo },
      include: {
        lote: { include: { sku: { include: { referencia: true, talla: true, color: true } } } },
        ubicacion: { include: { zona: true, bodega: true } },
      },
    });
    const quien = actor(req);
    if (!fila) {
      // Criterio 3: se informa y se ofrece reportar novedad (las novedades llegan fuera del corte C1).
      await registrarSuelto({ actor: quien, modulo: "IDENTIFICACION", evento: "identificador_no_reconocido", detalle: { codigo: codigo.slice(0, 60), modo: d.data.modo }, origen: req.ip });
      return reply.code(404).send({ error: "El código no está registrado en el sistema.", reconocido: false, ofrecerNovedad: true });
    }
    if (fila.estado === "ANULADO") {
      // Criterio 4: se informa y se rechaza la operación.
      await registrarSuelto({ actor: quien, modulo: "IDENTIFICACION", evento: "identificador_anulado_rechazado", entidad: "Identificador", entidadId: fila.id, detalle: { codigo: fila.codigo, modo: d.data.modo }, origen: req.ip });
      return reply.code(409).send({ error: "El identificador está anulado: no se puede operar con él.", reconocido: true, estado: "ANULADO" });
    }
    const identificador = { codigo: fila.codigo, estado: fila.estado };
    if (fila.lote) {
      const l = fila.lote;
      return { tipo: "MERCANCIA", identificador, sku: skuVista(l.sku), lote: { id: l.id, codigo: l.codigo, origen: l.origen, fechaIngreso: l.fechaIngreso.toISOString() }, ubicaciones: await ubicacionesConExistencia(l.skuId, l.id) };
    }
    const u = fila.ubicacion!;
    return { tipo: "UBICACION", identificador, ubicacion: { id: u.id, codigo: u.codigo, zona: u.zona.codigo, bodega: u.bodega.codigo, activa: u.activa } };
  });
};
