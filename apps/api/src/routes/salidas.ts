import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SalidaResumen, SalidaVista, TomaResultado } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { registrar, registrarSuelto } from "../bitacora.js";
import { aMilesimas, errorDeCantidad, numero } from "../entradas.js";
import { ErrorHttp, manejador } from "../errorHttp.js";
import { existenciaDePiezas } from "../inventario.js";
import { valorParametro } from "../parametros.js";
import { requiereRol } from "../permisos.js";
import { asignar, bloquear, disponiblesDe, liberar, liberarVencidas, totalDe, vistaDeSalida } from "../salidas.js";

/**
 * Matriz de permisos (SRS §3.3): solicitar = Administrador, Jefe y Coordinador; autorizar = Administrador y Jefe (el umbral del Coordinador,
 * RF-SAL-006, queda fuera del corte C1: toda salida la autoriza el Jefe); preparar y registrar la salida = también el Auxiliar. El Auditor solo lee.
 */
const solicita = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA");
const autoriza = requiereRol("ADMINISTRADOR", "JEFE_BODEGA");
const opera = requiereRol("ADMINISTRADOR", "JEFE_BODEGA", "COORDINADOR_BODEGA", "AUXILIAR_BODEGA");

const manejar = manejador("Esa existencia ya no está disponible: otra operación la comprometió antes. Vuelva a consultar.");

const id = z.string().min(1);
const crear = z.object({
  bodegaId: id.optional(),
  motivoId: z.string({ required_error: "Elija el motivo de la salida.", invalid_type_error: "Elija el motivo de la salida." }).min(1, "Elija el motivo de la salida."),
  observacion: z.string().trim().max(500).optional(),
  /** Si lo disponible no alcanza, se acepta sacar solo lo disponible (previa autorización del Jefe). */
  aceptarParcial: z.boolean().optional(),
  lineas: z.array(z.object({ skuId: id, loteId: id.optional(), cantidad: z.number({ invalid_type_error: "La cantidad no es válida." }) })).min(1, "Agregue al menos una línea.").max(50),
});
const tomar = z.object({
  mercanciaCodigo: z.string({ required_error: "Escanee el QR de la mercancía.", invalid_type_error: "Escanee el QR de la mercancía." }).trim().min(1, "Escanee el QR de la mercancía.").max(60),
  piezaId: z.string({ required_error: "Elija la pieza que toma.", invalid_type_error: "Elija la pieza que toma." }).min(1, "Elija la pieza que toma."),
  /** Si se indica, es lo que se corta de la pieza (corte parcial); por omisión, lo reservado. */
  cantidad: z.number({ invalid_type_error: "La cantidad no es válida." }).optional(),
});
const cancelar = z.object({ observacion: z.string().trim().max(500).optional() });

const mensajeZod = (e: z.ZodError) => e.issues.find((i) => i.message !== "Required")?.message ?? "Faltan datos de la salida.";
const PZ = (n: number) => `P-${String(n).padStart(6, "0")}`;

export const rutasSalidas: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.autenticar);
  const actor = (req: { user: { id: string; login: string } }) => ({ tipo: "USUARIO" as const, usuarioId: req.user.id, usuarioLogin: req.user.login });
  const quien = (req: { user: { id: string; login: string } }) => ({ id: req.user.id, login: req.user.login });

  async function cargar(salidaId: string): Promise<SalidaVista> {
    const v = await vistaDeSalida(prisma, salidaId);
    if (!v) throw new ErrorHttp(404, "Salida no encontrada.");
    return v;
  }

  /** Lista de salidas, las más recientes primero. Antes de leer se liberan las reservas vencidas. */
  app.get("/", manejar(async (req): Promise<SalidaResumen[]> => {
    await liberarVencidas();
    const { estado } = req.query as { estado?: string };
    const filas = await prisma.salida.findMany({ where: estado ? { estado: estado as never } : {}, include: { motivo: true, lineas: true }, orderBy: { numero: "desc" }, take: 200 });
    return filas.map((s) => ({
      id: s.id, numero: s.numero, estado: s.estado, motivo: s.motivo.nombre, parcial: s.parcial, solicitadaPor: s.solicitadaPorLogin, solicitadaEn: s.solicitadaEn.toISOString(),
      lineas: s.lineas.length, cantidad: s.lineas.reduce((a, l) => a + numero(l.cantidad), 0),
    }));
  }));

  app.get("/:salidaId", manejar(async (req): Promise<SalidaVista> => {
    await liberarVencidas();
    return cargar((req.params as { salidaId: string }).salidaId);
  }));

  /**
   * HU-SAL-001 y HU-SAL-004: la salida exige motivo tipificado y no pide cliente, precio ni factura (RN-SAL-002). Verifica la existencia disponible
   * antes de aceptar (RN-EXI-003): si no alcanza, rechaza, informa cuánto hay y ofrece sacar solo lo disponible (previa autorización). El rechazo queda registrado.
   */
  app.post("/", { preHandler: solicita }, manejar(async (req, reply) => {
    const d = crear.safeParse(req.body);
    if (!d.success) throw new ErrorHttp(422, mensajeZod(d.error));
    const motivo = await prisma.motivo.findUnique({ where: { id: d.data.motivoId } });
    if (!motivo || motivo.tipoOperacion !== "SALIDA") throw new ErrorHttp(422, "Elija un motivo de salida de la lista.");
    if (!motivo.activo) throw new ErrorHttp(422, "Ese motivo está desactivado.");
    // Los motivos que exigen evidencia (p. ej. baja por daño) piden además una observación; la evidencia adjunta llega después del corte C1.
    if (motivo.exigeEvidencia && !d.data.observacion) throw new ErrorHttp(422, `El motivo «${motivo.nombre}» exige una observación que explique lo ocurrido.`);
    const bodega = d.data.bodegaId ? await prisma.bodega.findUnique({ where: { id: d.data.bodegaId } }) : await prisma.bodega.findFirst({ orderBy: { codigo: "asc" } });
    if (!bodega) throw new ErrorHttp(404, "Bodega no encontrada.");

    const claves = new Set<string>();
    const lineas: Array<{ skuId: string; loteId: string | null; cantidad: number; pedida: number }> = [];
    let hayParcial = false;
    for (const [i, l] of d.data.lineas.entries()) {
      const sku = await prisma.sku.findUnique({ where: { id: l.skuId }, include: { referencia: true, talla: true, color: true } });
      if (!sku) throw new ErrorHttp(404, `La línea ${i + 1} pide un SKU que no existe.`);
      if (!sku.referencia.activa) throw new ErrorHttp(422, `La referencia ${sku.referencia.codigo} está desactivada.`);
      const errorCantidad = errorDeCantidad(sku.referencia.unidadMedida, l.cantidad);
      if (errorCantidad) throw new ErrorHttp(422, `Línea ${i + 1} (${sku.referencia.codigo}): ${errorCantidad}`);
      if (l.loteId) {
        const lote = await prisma.lote.findUnique({ where: { id: l.loteId } });
        if (!lote || lote.skuId !== sku.id) throw new ErrorHttp(422, `El lote de la línea ${i + 1} no es del SKU ${sku.referencia.codigo} ${sku.talla.nombre} ${sku.color.nombre}.`);
      }
      const clave = `${l.skuId}|${l.loteId ?? ""}`;
      if (claves.has(clave)) throw new ErrorHttp(422, `La línea ${i + 1} repite un SKU y lote ya pedidos: sume las cantidades en una sola línea.`);
      claves.add(clave);

      // RF-SAL-003: la existencia disponible se verifica antes de aceptar.
      const disponible = totalDe(await disponiblesDe(prisma, bodega.id, l.skuId, l.loteId));
      let cantidad = l.cantidad;
      if (aMilesimas(cantidad) > aMilesimas(disponible)) {
        const nombre = `${sku.referencia.codigo} ${sku.talla.nombre} ${sku.color.nombre}`;
        if (!d.data.aceptarParcial || disponible <= 0) {
          await registrarSuelto({ actor: actor(req), modulo: "SALIDAS", evento: "salida_rechazada_existencia_insuficiente", detalle: { sku: nombre, pedida: l.cantidad, disponible }, origen: req.ip });
          throw new ErrorHttp(409, disponible <= 0
            ? `No hay existencia disponible de ${nombre}${l.loteId ? " en ese lote" : ""}: no se puede sacar.`
            : `Solo hay ${disponible} disponible de ${nombre}${l.loteId ? " en ese lote" : ""} y se piden ${l.cantidad}. Puede registrar una salida parcial por ${disponible}, previa autorización del Jefe.`,
          { disponible, pedida: l.cantidad, linea: i + 1, ofrecerParcial: disponible > 0 });
        }
        cantidad = disponible; // salida parcial por lo disponible
        hayParcial = true;
      }
      lineas.push({ skuId: l.skuId, loteId: l.loteId ?? null, cantidad, pedida: l.cantidad });
    }

    const salida = await prisma.$transaction(async (tx) => {
      const nueva = await tx.salida.create({
        data: {
          bodegaId: bodega.id, motivoId: motivo.id, observacion: d.data.observacion ?? null, parcial: hayParcial, solicitadaPorId: req.user.id, solicitadaPorLogin: req.user.login,
          lineas: { create: lineas.map((l) => ({ skuId: l.skuId, loteId: l.loteId, cantidad: l.cantidad, cantidadPedida: l.pedida })) },
        },
      });
      await registrar(tx, { actor: actor(req), modulo: "SALIDAS", evento: "salida_solicitada", entidad: "Salida", entidadId: nueva.id, detalle: { salida: nueva.numero, motivo: motivo.nombre, lineas: lineas.length, parcial: hayParcial }, origen: req.ip });
      return nueva;
    });
    return reply.code(201).send(await cargar(salida.id));
  }));

  /**
   * HU-SAL-002: al autorizar, la cantidad comprometida pasa a reservada (RN-EXI-004) y deja de contar como disponible. El sistema elige las piezas
   * según la política de toma (RN-SAL-003). Si la existencia ya no alcanza, no se autoriza. La reserva vence en el plazo configurado (RN-SAL-005).
   */
  app.post("/:salidaId/autorizar", { preHandler: autoriza }, manejar(async (req, reply) => {
    const salidaId = (req.params as { salidaId: string }).salidaId;
    await liberarVencidas();
    const plazo = await valorParametro("plazo_reserva_horas");
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, salidaId);
      const s = await tx.salida.findUnique({ where: { id: salidaId }, include: { lineas: { include: { sku: { include: { referencia: true, talla: true, color: true } } } } } });
      if (!s) throw new ErrorHttp(404, "Salida no encontrada.");
      if (s.estado !== "SOLICITADA") throw new ErrorHttp(409, `La salida está ${s.estado.toLowerCase()}: solo se autoriza una salida solicitada.`);

      const reservas: Array<{ lineaId: string; piezaId: string; ubicacionId: string; cantidad: number }> = [];
      for (const l of s.lineas) {
        const { asignado, falta } = await asignar(await disponiblesDe(tx, s.bodegaId, l.skuId, l.loteId), numero(l.cantidad));
        if (falta > 0) {
          const nombre = `${l.sku.referencia.codigo} ${l.sku.talla.nombre} ${l.sku.color.nombre}`;
          throw new ErrorHttp(409, `Ya no hay existencia disponible suficiente de ${nombre}: faltan ${falta}. Cancele la salida o solicite otra con lo que hay.`);
        }
        reservas.push(...asignado.map((a) => ({ lineaId: l.id, ...a })));
      }
      const ahora = new Date();
      for (const r of reservas) await tx.reservaSalida.create({ data: r });
      // RN-EXI-004: un solo movimiento de reserva; el trigger de la base impide comprometer dos veces lo mismo, también entre operaciones simultáneas.
      const mov = await tx.movimiento.create({
        data: {
          tipo: "RESERVA", salidaId, usuarioId: req.user.id, usuarioLogin: req.user.login, iniciadoEn: ahora, confirmadoEn: ahora,
          asientos: { create: reservas.flatMap((r) => [
            { piezaId: r.piezaId, ubicacionId: r.ubicacionId, estado: "DISPONIBLE" as const, delta: -r.cantidad },
            { piezaId: r.piezaId, ubicacionId: r.ubicacionId, estado: "RESERVADO" as const, delta: r.cantidad },
          ]) },
        },
      });
      await tx.salida.update({ where: { id: salidaId }, data: { estado: "AUTORIZADA", autorizadaPorId: req.user.id, autorizadaPorLogin: req.user.login, autorizadaEn: ahora, venceEn: new Date(ahora.getTime() + plazo * 3600_000) } });
      await registrar(tx, { actor: actor(req), modulo: "SALIDAS", evento: "salida_autorizada", entidad: "Salida", entidadId: salidaId, detalle: { salida: s.numero, movimientoId: mov.id, piezasReservadas: reservas.length, plazoHoras: plazo, parcial: s.parcial }, origen: req.ip });
    });
    return reply.send(await cargar(salidaId));
  }));

  /** Cancelar una salida solicitada o autorizada: la reserva vuelve a disponible (HU-SAL-002 criterio 4). La cancela quien la solicitó o el Jefe. */
  app.post("/:salidaId/cancelar", { preHandler: solicita }, manejar(async (req, reply) => {
    const salidaId = (req.params as { salidaId: string }).salidaId;
    const d = cancelar.safeParse(req.body ?? {});
    await liberarVencidas();
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, salidaId);
      const s = await tx.salida.findUnique({ where: { id: salidaId } });
      if (!s) throw new ErrorHttp(404, "Salida no encontrada.");
      if (s.estado !== "SOLICITADA" && s.estado !== "AUTORIZADA") throw new ErrorHttp(409, `La salida está ${s.estado.toLowerCase()}: ya no se puede cancelar.`);
      const esJefe = req.user.rol === "ADMINISTRADOR" || req.user.rol === "JEFE_BODEGA";
      if (!esJefe && s.solicitadaPorId !== req.user.id) throw new ErrorHttp(403, "Solo quien solicitó la salida o el Jefe de Bodega puede cancelarla.");
      let liberadas = 0;
      if (s.estado === "AUTORIZADA") {
        const reservas = await tx.reservaSalida.findMany({ where: { linea: { salidaId } } });
        await liberar(tx, salidaId, quien(req), reservas.map((r) => ({ piezaId: r.piezaId, ubicacionId: r.ubicacionId, cantidad: numero(r.cantidad) })));
        liberadas = reservas.length;
      }
      await tx.salida.update({ where: { id: salidaId }, data: { estado: "CANCELADA", canceladaPorLogin: req.user.login, canceladaEn: new Date() } });
      await registrar(tx, { actor: actor(req), modulo: "SALIDAS", evento: "salida_cancelada", entidad: "Salida", entidadId: salidaId, detalle: { salida: s.numero, estabaAutorizada: s.estado === "AUTORIZADA", reservasLiberadas: liberadas, ...(d.success && d.data.observacion ? { observacion: d.data.observacion } : {}) }, origen: req.ip });
    });
    return reply.send(await cargar(salidaId));
  }));

  /**
   * HU-SAL-003, HU-SAL-008 y HU-SAL-009: al preparar, el Auxiliar escanea la mercancía y elige la pieza. El escaneo que no corresponde se rechaza
   * explicando la discrepancia (RN-SAL-004); cada pieza se cuenta una sola vez (RN-SAL-009); si toma solo una parte de la pieza es un corte parcial
   * (RN-SAL-008) y no puede superar lo que tiene. Lo tomado se descuenta del kardex al confirmar.
   */
  app.post("/:salidaId/tomar", { preHandler: opera }, manejar(async (req, reply) => {
    const salidaId = (req.params as { salidaId: string }).salidaId;
    const d = tomar.safeParse(req.body);
    if (!d.success) throw new ErrorHttp(422, mensajeZod(d.error));
    await liberarVencidas();

    const resultado = await prisma.$transaction(async (tx): Promise<{ yaContada: boolean; pieza: number; cantidad: number; corte: boolean; restante: number }> => {
      await bloquear(tx, salidaId);
      const s = await tx.salida.findUnique({ where: { id: salidaId }, include: { lineas: { include: { sku: { include: { referencia: true, talla: true, color: true } }, lote: true, reservas: { include: { toma: true } } } } } });
      if (!s) throw new ErrorHttp(404, "Salida no encontrada.");
      if (s.estado === "VENCIDA") throw new ErrorHttp(409, "La reserva de esta salida venció y se liberó: pida que la autoricen de nuevo.");
      if (s.estado !== "AUTORIZADA") throw new ErrorHttp(409, `La salida está ${s.estado.toLowerCase()}: solo se prepara una salida autorizada.`);

      // El QR identifica SKU + Lote; la pieza que se elige debe ser de ese lote.
      const ident = await tx.identificador.findUnique({ where: { codigo: d.data.mercanciaCodigo.toUpperCase() } });
      if (!ident || ident.tipo !== "MERCANCIA" || !ident.loteId) throw new ErrorHttp(404, "El código escaneado no está registrado como mercancía.", { reconocido: false, ofrecerNovedad: true });
      if (ident.estado === "ANULADO") throw new ErrorHttp(409, "El identificador de la mercancía está anulado: no se puede operar con él.");
      const lote = await tx.lote.findUniqueOrThrow({ where: { id: ident.loteId }, include: { sku: { include: { referencia: true, talla: true, color: true } } } });
      const pieza = await tx.pieza.findUnique({ where: { id: d.data.piezaId }, include: { linea: true } });
      if (!pieza) throw new ErrorHttp(404, "Pieza no encontrada.");
      if (pieza.linea.loteId !== lote.id) throw new ErrorHttp(409, `La pieza ${PZ(pieza.numero)} no es del lote escaneado (${lote.codigo}).`);

      const reserva = s.lineas.flatMap((l) => l.reservas.map((r) => ({ r, l }))).find((x) => x.r.piezaId === pieza.id);
      if (!reserva) {
        // RN-SAL-004: se dice la discrepancia concreta (referencia, talla, color o lote).
        const sku = lote.sku;
        const linea = s.lineas.find((l) => l.skuId === sku.id) ?? s.lineas.find((l) => l.sku.referenciaId === sku.referenciaId) ?? s.lineas[0]!;
        const difiere: string[] = [];
        if (linea.sku.referenciaId !== sku.referenciaId) difiere.push(`referencia (se pide ${linea.sku.referencia.codigo}, se escaneó ${sku.referencia.codigo})`);
        if (linea.sku.tallaId !== sku.tallaId) difiere.push(`talla (se pide ${linea.sku.talla.nombre}, se escaneó ${sku.talla.nombre})`);
        if (linea.sku.colorId !== sku.colorId) difiere.push(`color (se pide ${linea.sku.color.nombre}, se escaneó ${sku.color.nombre})`);
        let mensaje: string;
        if (difiere.length > 0) mensaje = `Lo escaneado no corresponde a lo solicitado: difiere en ${difiere.join(", ")}.`;
        else {
          const reservadas = s.lineas.filter((l) => l.skuId === sku.id).flatMap((l) => l.reservas);
          mensaje = linea.lote && linea.lote.id !== lote.id
            ? `Lo escaneado no corresponde a lo solicitado: difiere en lote (se pide ${linea.lote.codigo}, se escaneó ${lote.codigo}).`
            : `La pieza ${PZ(pieza.numero)} no es una de las reservadas para esta salida${reservadas.length > 0 ? ": revise la lista de piezas por tomar" : ""}.`;
        }
        await registrarSuelto({ actor: actor(req), modulo: "SALIDAS", evento: "escaneo_salida_rechazado", entidad: "Salida", entidadId: salidaId, detalle: { salida: s.numero, pieza: pieza.numero, lote: lote.codigo, discrepancia: mensaje }, origen: req.ip });
        throw new ErrorHttp(409, mensaje, { discrepancia: true });
      }
      const { r } = reserva;
      const enUbicacion = (await existenciaDePiezas([pieza.id], tx)).get(pieza.id) ?? [];
      const piezaTotal = enUbicacion.filter((x) => x.ubicacionId === r.ubicacionId).reduce((a, x) => a + x.cantidad, 0);
      const reservado = numero(r.cantidad);

      // RN-SAL-009: seleccionar de nuevo la misma pieza no suma.
      if (r.toma) return { yaContada: true, pieza: pieza.numero, cantidad: numero(r.toma.cantidad), corte: aMilesimas(numero(r.toma.cantidad)) < aMilesimas(piezaTotal), restante: piezaTotal - numero(r.toma.cantidad) };

      const cantidad = d.data.cantidad ?? reservado;
      const errorCantidad = errorDeCantidad(reserva.l.sku.referencia.unidadMedida, cantidad);
      if (errorCantidad) throw new ErrorHttp(422, errorCantidad);
      // RN-SAL-008 / RN-EXI-001: lo cortado no puede superar la cantidad de la pieza, ni lo reservado para esta salida.
      if (aMilesimas(cantidad) > aMilesimas(piezaTotal)) throw new ErrorHttp(409, `La cantidad cortada no puede superar la de la pieza: ${PZ(pieza.numero)} tiene ${piezaTotal}.`);
      if (aMilesimas(cantidad) > aMilesimas(reservado)) throw new ErrorHttp(409, `Solo se reservaron ${reservado} de ${PZ(pieza.numero)} para esta salida: no se puede tomar ${cantidad}.`);
      await tx.tomaSalida.create({ data: { reservaId: r.id, cantidad, tomadaPorId: req.user.id, tomadaPorLogin: req.user.login } });
      const corte = aMilesimas(cantidad) < aMilesimas(piezaTotal);
      await registrar(tx, { actor: actor(req), modulo: "SALIDAS", evento: "pieza_tomada", entidad: "Salida", entidadId: salidaId, detalle: { salida: s.numero, pieza: pieza.numero, cantidad, corte, restante: (aMilesimas(piezaTotal) - aMilesimas(cantidad)) / 1000 }, origen: req.ip });
      return { yaContada: false, pieza: pieza.numero, cantidad, corte, restante: (aMilesimas(piezaTotal) - aMilesimas(cantidad)) / 1000 };
    });
    const salida = await cargar(salidaId);
    const respuesta: TomaResultado = { ...resultado, salida };
    return reply.code(resultado.yaContada ? 200 : 201).send(respuesta);
  }));

  /**
   * HU-SAL-003 criterio 5 y RN-SAL-009: la salida no se confirma completa mientras falten piezas o cantidad, salvo salida parcial autorizada.
   * Confirmar descuenta del kardex lo tomado (RF-SAL-009), con el motivo y la autorización de la salida, y libera lo reservado y no tomado.
   */
  app.post("/:salidaId/confirmar", { preHandler: opera }, manejar(async (req, reply) => {
    const salidaId = (req.params as { salidaId: string }).salidaId;
    await liberarVencidas();
    await prisma.$transaction(async (tx) => {
      await bloquear(tx, salidaId);
      const s = await tx.salida.findUnique({ where: { id: salidaId } });
      if (!s) throw new ErrorHttp(404, "Salida no encontrada.");
      if (s.estado === "VENCIDA") throw new ErrorHttp(409, "La reserva de esta salida venció y se liberó: pida que la autoricen de nuevo.");
      if (s.estado !== "AUTORIZADA") throw new ErrorHttp(409, `La salida está ${s.estado.toLowerCase()}: solo se confirma una salida autorizada.`);
      const v = (await vistaDeSalida(tx, salidaId))!;
      if (!v.completa) {
        const tomado = v.reservas.reduce((a, r) => a + (r.tomada ?? 0), 0);
        if (!s.parcial) {
          const faltan = v.detalle.flatMap((l) => (aMilesimas(l.tomada) < aMilesimas(l.cantidad) ? [`${l.sku.referencia} ${l.sku.talla} ${l.sku.color}: tomado ${l.tomada} de ${l.cantidad}`] : []));
          const sinTomar = v.reservas.filter((r) => r.tomada === null).map((r) => PZ(r.pieza));
          throw new ErrorHttp(409, `La preparación está incompleta: ${faltan.join("; ") || "faltan piezas por escanear"}${sinTomar.length ? `. Piezas sin escanear: ${sinTomar.join(", ")}` : ""}. Solo una salida parcial autorizada se confirma incompleta.`);
        }
        if (aMilesimas(tomado) <= 0) throw new ErrorHttp(409, "No se ha tomado ninguna pieza: no hay nada que confirmar.");
      }
      const reservas = await tx.reservaSalida.findMany({ where: { linea: { salidaId } }, include: { toma: true } });
      const ahora = new Date();
      const tomadas = reservas.filter((r) => r.toma);
      const salida = await tx.movimiento.create({
        data: {
          tipo: "SALIDA", salidaId, motivoId: s.motivoId, usuarioId: req.user.id, usuarioLogin: req.user.login, iniciadoEn: ahora, confirmadoEn: ahora,
          asientos: { create: tomadas.map((r) => ({ piezaId: r.piezaId, ubicacionId: r.ubicacionId, estado: "RESERVADO" as const, delta: numero(r.toma!.cantidad) * -1 })) },
        },
      });
      // Lo reservado y no tomado vuelve a disponible.
      await liberar(tx, salidaId, quien(req), reservas.map((r) => ({ piezaId: r.piezaId, ubicacionId: r.ubicacionId, cantidad: (aMilesimas(numero(r.cantidad)) - aMilesimas(r.toma ? numero(r.toma.cantidad) : 0)) / 1000 })));
      await tx.salida.update({ where: { id: salidaId }, data: { estado: "CONFIRMADA", confirmadaPorLogin: req.user.login, confirmadaEn: ahora } });
      await registrar(tx, { actor: actor(req), modulo: "SALIDAS", evento: "salida_confirmada", entidad: "Salida", entidadId: salidaId, detalle: { salida: s.numero, movimientoId: salida.id, piezas: tomadas.length, parcial: s.parcial, autorizadaPor: s.autorizadaPorLogin }, origen: req.ip });
    });
    return reply.send(await cargar(salidaId));
  }));
};

