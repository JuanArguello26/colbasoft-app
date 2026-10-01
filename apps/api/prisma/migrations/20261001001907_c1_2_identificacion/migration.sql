-- CreateEnum
CREATE TYPE "IdentificadorTipo" AS ENUM ('MERCANCIA', 'UBICACION');

-- CreateEnum
CREATE TYPE "IdentificadorEstado" AS ENUM ('ACTIVO', 'ANULADO');

-- CreateTable
CREATE TABLE "Lote" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "fechaIngreso" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identificador" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" "IdentificadorTipo" NOT NULL,
    "estado" "IdentificadorEstado" NOT NULL DEFAULT 'ACTIVO',
    "loteId" TEXT,
    "ubicacionId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identificador_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lote_skuId_codigo_key" ON "Lote"("skuId", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Identificador_codigo_key" ON "Identificador"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Identificador_loteId_key" ON "Identificador"("loteId");

-- CreateIndex
CREATE UNIQUE INDEX "Identificador_ubicacionId_key" ON "Identificador"("ubicacionId");

-- AddForeignKey
ALTER TABLE "Lote" ADD CONSTRAINT "Lote_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identificador" ADD CONSTRAINT "Identificador_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "Lote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identificador" ADD CONSTRAINT "Identificador_ubicacionId_fkey" FOREIGN KEY ("ubicacionId") REFERENCES "Ubicacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DF5-01: un identificador de mercancía apunta a un lote y uno de ubicación apunta a una ubicación, nunca a ambos.
ALTER TABLE "Identificador" ADD CONSTRAINT "Identificador_tipo_coherente" CHECK (
  ("tipo" = 'MERCANCIA' AND "loteId" IS NOT NULL AND "ubicacionId" IS NULL)
  OR ("tipo" = 'UBICACION' AND "ubicacionId" IS NOT NULL AND "loteId" IS NULL)
);

-- RN-IDE-002 / RF-QRC-002: un identificador emitido no se borra ni se reasigna, así su valor nunca puede reutilizarse.
-- Lo único que cambia es el estado (activo -> anulado).
CREATE OR REPLACE FUNCTION identificador_inalterable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Un identificador emitido no se elimina (RN-IDE-002): anúlelo en su lugar';
  END IF;
  IF NEW."codigo" IS DISTINCT FROM OLD."codigo" OR NEW."tipo" IS DISTINCT FROM OLD."tipo"
     OR NEW."loteId" IS DISTINCT FROM OLD."loteId" OR NEW."ubicacionId" IS DISTINCT FROM OLD."ubicacionId" THEN
    RAISE EXCEPTION 'Un identificador emitido no cambia de valor ni de referencia (RN-IDE-002)';
  END IF;
  IF OLD."estado" = 'ANULADO' AND NEW."estado" <> 'ANULADO' THEN
    RAISE EXCEPTION 'Un identificador anulado no se reactiva (RN-IDE-002)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identificador_sin_alterar BEFORE UPDATE OR DELETE ON "Identificador"
  FOR EACH ROW EXECUTE FUNCTION identificador_inalterable();

CREATE TRIGGER identificador_sin_truncar BEFORE TRUNCATE ON "Identificador"
  FOR EACH STATEMENT EXECUTE FUNCTION identificador_inalterable();
