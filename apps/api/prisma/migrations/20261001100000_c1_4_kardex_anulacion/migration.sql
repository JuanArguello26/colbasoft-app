-- AlterEnum
ALTER TYPE "TipoMovimiento" ADD VALUE 'ANULACION';

-- AlterTable
ALTER TABLE "Movimiento" ADD COLUMN     "anulaAId" TEXT,
ADD COLUMN     "motivoId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Movimiento_anulaAId_key" ON "Movimiento"("anulaAId");

-- AddForeignKey
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_anulaAId_fkey" FOREIGN KEY ("anulaAId") REFERENCES "Movimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_motivoId_fkey" FOREIGN KEY ("motivoId") REFERENCES "Motivo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- RF-KDX-004: una anulación siempre dice qué movimiento neutraliza y con qué motivo; ningún otro tipo lo lleva.
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_anulacion_coherente" CHECK (
  ("tipo"::text = 'ANULACION' AND "anulaAId" IS NOT NULL AND "motivoId" IS NOT NULL)
  OR ("tipo"::text <> 'ANULACION' AND "anulaAId" IS NULL AND "motivoId" IS NULL)
);
