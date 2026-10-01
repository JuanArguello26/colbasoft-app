-- CreateEnum
CREATE TYPE "EstadoDocumentoEntrada" AS ENUM ('PENDIENTE_RECEPCION', 'RECEPCION_PARCIAL', 'RECIBIDO_CONFORME', 'RECIBIDO_CON_NOVEDAD', 'CONFIRMADO');

-- CreateEnum
CREATE TYPE "TipoPieza" AS ENUM ('ROLLO', 'PAQUETE', 'BOLSA');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'MOVIMIENTO_INTERNO');

-- CreateEnum
CREATE TYPE "EstadoExistencia" AS ENUM ('EN_RECEPCION', 'DISPONIBLE');

-- CreateEnum
CREATE TYPE "ModoIdentificacion" AS ENUM ('ESCANEO', 'MANUAL');

-- AlterTable
ALTER TABLE "Zona" ADD COLUMN     "categoriaId" TEXT;

-- CreateTable
CREATE TABLE "DocumentoEntrada" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "bodegaId" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "fechaEsperada" DATE NOT NULL,
    "estado" "EstadoDocumentoEntrada" NOT NULL DEFAULT 'PENDIENTE_RECEPCION',
    "creadoPorId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "llegadaEn" TIMESTAMP(3),
    "sobranteAutorizadoPorId" TEXT,
    "sobranteAutorizadoEn" TIMESTAMP(3),
    "confirmadoPorId" TEXT,
    "confirmadoEn" TIMESTAMP(3),
    "ubicacionRecepcionId" TEXT,

    CONSTRAINT "DocumentoEntrada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaEntrada" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "cantidadEsperada" DECIMAL(14,3) NOT NULL,
    "diferencia" DECIMAL(14,3),
    "loteId" TEXT,

    CONSTRAINT "LineaEntrada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pieza" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "lineaId" TEXT NOT NULL,
    "tipo" "TipoPieza" NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "registradaPorId" TEXT NOT NULL,
    "registradaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pieza_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Movimiento" (
    "id" TEXT NOT NULL,
    "secuencia" SERIAL NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "documentoEntradaId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "usuarioLogin" TEXT NOT NULL,
    "iniciadoEn" TIMESTAMP(3) NOT NULL,
    "confirmadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modoIdentificacion" "ModoIdentificacion",
    "propuestaUbicacionId" TEXT,
    "desviacion" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Movimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsientoKardex" (
    "id" TEXT NOT NULL,
    "movimientoId" TEXT NOT NULL,
    "piezaId" TEXT NOT NULL,
    "ubicacionId" TEXT NOT NULL,
    "estado" "EstadoExistencia" NOT NULL,
    "delta" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "AsientoKardex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentoEntrada_numero_key" ON "DocumentoEntrada"("numero");

-- CreateIndex
CREATE INDEX "DocumentoEntrada_estado_idx" ON "DocumentoEntrada"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "LineaEntrada_documentoId_skuId_key" ON "LineaEntrada"("documentoId", "skuId");

-- CreateIndex
CREATE UNIQUE INDEX "Pieza_numero_key" ON "Pieza"("numero");

-- CreateIndex
CREATE INDEX "Pieza_lineaId_idx" ON "Pieza"("lineaId");

-- CreateIndex
CREATE UNIQUE INDEX "Movimiento_secuencia_key" ON "Movimiento"("secuencia");

-- CreateIndex
CREATE INDEX "Movimiento_documentoEntradaId_idx" ON "Movimiento"("documentoEntradaId");

-- CreateIndex
CREATE INDEX "AsientoKardex_piezaId_ubicacionId_estado_idx" ON "AsientoKardex"("piezaId", "ubicacionId", "estado");

-- CreateIndex
CREATE INDEX "AsientoKardex_ubicacionId_idx" ON "AsientoKardex"("ubicacionId");

-- CreateIndex
CREATE INDEX "AsientoKardex_movimientoId_idx" ON "AsientoKardex"("movimientoId");

-- AddForeignKey
ALTER TABLE "Zona" ADD CONSTRAINT "Zona_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "Categoria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentoEntrada" ADD CONSTRAINT "DocumentoEntrada_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaEntrada" ADD CONSTRAINT "LineaEntrada_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "DocumentoEntrada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaEntrada" ADD CONSTRAINT "LineaEntrada_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaEntrada" ADD CONSTRAINT "LineaEntrada_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "Lote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pieza" ADD CONSTRAINT "Pieza_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaEntrada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_documentoEntradaId_fkey" FOREIGN KEY ("documentoEntradaId") REFERENCES "DocumentoEntrada"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsientoKardex" ADD CONSTRAINT "AsientoKardex_movimientoId_fkey" FOREIGN KEY ("movimientoId") REFERENCES "Movimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsientoKardex" ADD CONSTRAINT "AsientoKardex_piezaId_fkey" FOREIGN KEY ("piezaId") REFERENCES "Pieza"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsientoKardex" ADD CONSTRAINT "AsientoKardex_ubicacionId_fkey" FOREIGN KEY ("ubicacionId") REFERENCES "Ubicacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cantidades con sentido: una línea espera algo y una pieza trae algo; un asiento siempre mueve algo.
ALTER TABLE "LineaEntrada" ADD CONSTRAINT "LineaEntrada_cantidad_positiva" CHECK ("cantidadEsperada" > 0);
ALTER TABLE "Pieza" ADD CONSTRAINT "Pieza_cantidad_positiva" CHECK ("cantidad" > 0);
ALTER TABLE "AsientoKardex" ADD CONSTRAINT "AsientoKardex_delta_distinto_de_cero" CHECK ("delta" <> 0);

-- RN-INT-002: el kardex es inmutable. Un error se corrige con un movimiento inverso, nunca editando ni borrando.
CREATE OR REPLACE FUNCTION kardex_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El kardex es inmutable (RN-INT-002): no se permite % sobre %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER movimiento_sin_modificar BEFORE UPDATE OR DELETE ON "Movimiento"
  FOR EACH ROW EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER movimiento_sin_truncar BEFORE TRUNCATE ON "Movimiento"
  FOR EACH STATEMENT EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER asiento_sin_modificar BEFORE UPDATE OR DELETE ON "AsientoKardex"
  FOR EACH ROW EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER asiento_sin_truncar BEFORE TRUNCATE ON "AsientoKardex"
  FOR EACH STATEMENT EXECUTE FUNCTION kardex_inmutable();

-- RN-EXI-001: ninguna operación deja la existencia por debajo de cero, sin excepción. Se comprueba en la base de datos,
-- con un candado por (pieza, ubicación, estado) para que dos operaciones simultáneas no se salten la regla.
CREATE OR REPLACE FUNCTION asiento_no_negativo() RETURNS trigger AS $$
DECLARE actual numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."piezaId" || '|' || NEW."ubicacionId" || '|' || NEW."estado"::text));
  SELECT COALESCE(SUM("delta"), 0) INTO actual FROM "AsientoKardex"
    WHERE "piezaId" = NEW."piezaId" AND "ubicacionId" = NEW."ubicacionId" AND "estado" = NEW."estado";
  IF actual + NEW."delta" < 0 THEN
    RAISE EXCEPTION 'La existencia no puede quedar por debajo de cero (RN-EXI-001)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asiento_existencia_no_negativa BEFORE INSERT ON "AsientoKardex"
  FOR EACH ROW EXECUTE FUNCTION asiento_no_negativo();
