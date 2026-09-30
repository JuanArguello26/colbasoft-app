-- CreateEnum
CREATE TYPE "ActorTipo" AS ENUM ('USUARIO', 'SISTEMA');

-- CreateEnum
CREATE TYPE "TipoOperacion" AS ENUM ('AJUSTE', 'ANULACION', 'SALIDA', 'DESCARTE_ALERTA');

-- AlterTable
ALTER TABLE "Categoria" ADD COLUMN     "activa" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Ubicacion" ADD COLUMN     "capacidad" DOUBLE PRECISION,
ADD COLUMN     "unidadCapacidad" "UnidadMedida";

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "bloqueado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "debeCambiarClave" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intentosFallidos" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Parametro" (
    "clave" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoPor" TEXT,

    CONSTRAINT "Parametro_pkey" PRIMARY KEY ("clave")
);

-- CreateTable
CREATE TABLE "Motivo" (
    "id" TEXT NOT NULL,
    "tipoOperacion" "TipoOperacion" NOT NULL,
    "nombre" TEXT NOT NULL,
    "exigeEvidencia" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Motivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistroBitacora" (
    "seq" BIGSERIAL NOT NULL,
    "instante" TIMESTAMP(3) NOT NULL,
    "actorTipo" "ActorTipo" NOT NULL,
    "usuarioId" TEXT,
    "usuarioLogin" TEXT,
    "modulo" TEXT NOT NULL,
    "evento" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "detalle" JSONB,
    "origen" TEXT,
    "hashAnterior" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "RegistroBitacora_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "Motivo_tipoOperacion_nombre_key" ON "Motivo"("tipoOperacion", "nombre");

-- CreateIndex
CREATE INDEX "RegistroBitacora_instante_idx" ON "RegistroBitacora"("instante");

-- CreateIndex
CREATE INDEX "RegistroBitacora_modulo_idx" ON "RegistroBitacora"("modulo");

-- CreateIndex
CREATE INDEX "RegistroBitacora_evento_idx" ON "RegistroBitacora"("evento");

-- CreateIndex
CREATE INDEX "RegistroBitacora_usuarioId_idx" ON "RegistroBitacora"("usuarioId");

-- RN-061 / RF-AUD-002: la bitácora no se edita ni se borra, para ningún rol, incluido el administrador de la base de datos de la aplicación.
CREATE OR REPLACE FUNCTION bitacora_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora de auditoría es inmutable (RN-061): no se permite % sobre RegistroBitacora', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bitacora_sin_modificar BEFORE UPDATE OR DELETE ON "RegistroBitacora"
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

CREATE TRIGGER bitacora_sin_truncar BEFORE TRUNCATE ON "RegistroBitacora"
  FOR EACH STATEMENT EXECUTE FUNCTION bitacora_inmutable();
