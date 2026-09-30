-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('ADMINISTRADOR', 'JEFE_BODEGA', 'COORDINADOR_BODEGA', 'AUXILIAR_BODEGA', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UnidadMedida" AS ENUM ('UNIDADES', 'METROS', 'ROLLOS', 'KILOGRAMOS');

-- CreateEnum
CREATE TYPE "ZonaTipo" AS ENUM ('RECEPCION', 'ALMACENAMIENTO', 'PREPARACION_SALIDA', 'CUARENTENA');

-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "rol" "Rol" NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Categoria" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referencia" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "categoriaId" TEXT NOT NULL,
    "unidadMedida" "UnidadMedida" NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Referencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Talla" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Talla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Color" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Color_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sku" (
    "id" TEXT NOT NULL,
    "referenciaId" TEXT NOT NULL,
    "tallaId" TEXT NOT NULL,
    "colorId" TEXT NOT NULL,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bodega" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Bodega_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zona" (
    "id" TEXT NOT NULL,
    "bodegaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "ZonaTipo" NOT NULL,

    CONSTRAINT "Zona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ubicacion" (
    "id" TEXT NOT NULL,
    "bodegaId" TEXT NOT NULL,
    "zonaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Ubicacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_login_key" ON "Usuario"("login");

-- CreateIndex
CREATE UNIQUE INDEX "Categoria_nombre_key" ON "Categoria"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Referencia_codigo_key" ON "Referencia"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Talla_nombre_key" ON "Talla"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Color_nombre_key" ON "Color"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_referenciaId_tallaId_colorId_key" ON "Sku"("referenciaId", "tallaId", "colorId");

-- CreateIndex
CREATE UNIQUE INDEX "Bodega_codigo_key" ON "Bodega"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Zona_bodegaId_codigo_key" ON "Zona"("bodegaId", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Ubicacion_bodegaId_codigo_key" ON "Ubicacion"("bodegaId", "codigo");

-- AddForeignKey
ALTER TABLE "Referencia" ADD CONSTRAINT "Referencia_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "Categoria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_referenciaId_fkey" FOREIGN KEY ("referenciaId") REFERENCES "Referencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_tallaId_fkey" FOREIGN KEY ("tallaId") REFERENCES "Talla"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "Color"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zona" ADD CONSTRAINT "Zona_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ubicacion" ADD CONSTRAINT "Ubicacion_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ubicacion" ADD CONSTRAINT "Ubicacion_zonaId_fkey" FOREIGN KEY ("zonaId") REFERENCES "Zona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
