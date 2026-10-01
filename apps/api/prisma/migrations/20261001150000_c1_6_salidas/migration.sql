-- CreateEnum
CREATE TYPE "EstadoSalida" AS ENUM ('SOLICITADA', 'AUTORIZADA', 'CONFIRMADA', 'CANCELADA', 'VENCIDA');

-- AlterEnum
ALTER TYPE "EstadoExistencia" ADD VALUE 'RESERVADO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TipoMovimiento" ADD VALUE 'RESERVA';
ALTER TYPE "TipoMovimiento" ADD VALUE 'SALIDA';
ALTER TYPE "TipoMovimiento" ADD VALUE 'LIBERACION';

-- AlterTable
ALTER TABLE "Movimiento" ADD COLUMN     "salidaId" TEXT;

-- CreateTable
CREATE TABLE "Salida" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "bodegaId" TEXT NOT NULL,
    "motivoId" TEXT NOT NULL,
    "observacion" TEXT,
    "estado" "EstadoSalida" NOT NULL DEFAULT 'SOLICITADA',
    "parcial" BOOLEAN NOT NULL DEFAULT false,
    "solicitadaPorId" TEXT NOT NULL,
    "solicitadaPorLogin" TEXT NOT NULL,
    "solicitadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autorizadaPorId" TEXT,
    "autorizadaPorLogin" TEXT,
    "autorizadaEn" TIMESTAMP(3),
    "venceEn" TIMESTAMP(3),
    "confirmadaPorLogin" TEXT,
    "confirmadaEn" TIMESTAMP(3),
    "canceladaPorLogin" TEXT,
    "canceladaEn" TIMESTAMP(3),

    CONSTRAINT "Salida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaSalida" (
    "id" TEXT NOT NULL,
    "salidaId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "loteId" TEXT,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "cantidadPedida" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "LineaSalida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservaSalida" (
    "id" TEXT NOT NULL,
    "lineaId" TEXT NOT NULL,
    "piezaId" TEXT NOT NULL,
    "ubicacionId" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "ReservaSalida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TomaSalida" (
    "id" TEXT NOT NULL,
    "reservaId" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "tomadaPorId" TEXT NOT NULL,
    "tomadaPorLogin" TEXT NOT NULL,
    "tomadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TomaSalida_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Salida_numero_key" ON "Salida"("numero");

-- CreateIndex
CREATE INDEX "Salida_estado_idx" ON "Salida"("estado");

-- CreateIndex
CREATE INDEX "ReservaSalida_lineaId_idx" ON "ReservaSalida"("lineaId");

-- CreateIndex
CREATE UNIQUE INDEX "TomaSalida_reservaId_key" ON "TomaSalida"("reservaId");

-- AddForeignKey
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_salidaId_fkey" FOREIGN KEY ("salidaId") REFERENCES "Salida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Salida" ADD CONSTRAINT "Salida_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Salida" ADD CONSTRAINT "Salida_motivoId_fkey" FOREIGN KEY ("motivoId") REFERENCES "Motivo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaSalida" ADD CONSTRAINT "LineaSalida_salidaId_fkey" FOREIGN KEY ("salidaId") REFERENCES "Salida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaSalida" ADD CONSTRAINT "LineaSalida_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaSalida" ADD CONSTRAINT "LineaSalida_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "Lote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservaSalida" ADD CONSTRAINT "ReservaSalida_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaSalida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservaSalida" ADD CONSTRAINT "ReservaSalida_piezaId_fkey" FOREIGN KEY ("piezaId") REFERENCES "Pieza"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservaSalida" ADD CONSTRAINT "ReservaSalida_ubicacionId_fkey" FOREIGN KEY ("ubicacionId") REFERENCES "Ubicacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TomaSalida" ADD CONSTRAINT "TomaSalida_reservaId_fkey" FOREIGN KEY ("reservaId") REFERENCES "ReservaSalida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Cantidades con sentido: una línea pide algo, una reserva y una toma mueven algo.
ALTER TABLE "LineaSalida" ADD CONSTRAINT "LineaSalida_cantidad_positiva" CHECK ("cantidad" > 0 AND "cantidadPedida" >= "cantidad");
ALTER TABLE "ReservaSalida" ADD CONSTRAINT "ReservaSalida_cantidad_positiva" CHECK ("cantidad" > 0);
ALTER TABLE "TomaSalida" ADD CONSTRAINT "TomaSalida_cantidad_positiva" CHECK ("cantidad" > 0);

-- Un movimiento dice de qué es: la anulación, qué neutraliza y con qué motivo (RF-KDX-004); la salida, su motivo (RN-SAL-002);
-- la reserva, la salida y la liberación pertenecen a una salida. Se castea a texto porque un valor nuevo de un enum no se puede usar
-- en la misma transacción que lo crea.
ALTER TABLE "Movimiento" DROP CONSTRAINT "Movimiento_anulacion_coherente";
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_origen_coherente" CHECK (
  (("tipo"::text = 'ANULACION') = ("anulaAId" IS NOT NULL))
  AND (("tipo"::text IN ('ANULACION', 'SALIDA')) = ("motivoId" IS NOT NULL))
  AND (("tipo"::text IN ('RESERVA', 'SALIDA', 'LIBERACION')) = ("salidaId" IS NOT NULL))
);
