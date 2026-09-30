# COLBASOFT · Aplicación

Plataforma de trazabilidad de inventarios para PYMES textiles (proyecto de grado). Este repositorio contiene **el código**; los documentos (SPEC, SRS, dominio, arquitectura) están en el repositorio `colbasoft-docs`.

> **Estado:** esqueleto del corte de entrega **C1** (SPEC v1.5 §12.7). Bloque C1-1 (Fundación) iniciado: inicio de sesión, base de datos, catálogo y carga de datos ficticios.
> **Datos:** el proyecto se valida **solo con datos ficticios** (SPEC §12.8). El Excel es **únicamente una carga de datos de prueba**; la base de datos es PostgreSQL.

## Pila (ADR-001)

TypeScript · Node 24 · Fastify · Prisma · PostgreSQL (Docker) · React + Vite · Vitest · monorepo con `npm workspaces`.

```
apps/api         servidor (Fastify + Prisma)
apps/web         cliente web (React + Vite), pensado para tablet
packages/shared  tipos comunes (roles, unidades de medida)
data/            datos ficticios (Excel)
```

## Puesta en marcha

Requisitos: Node 22 o superior, Docker.

```bash
npm install
npm run build -w @colbasoft/shared   # una vez: compila los tipos compartidos
cp .env.example apps/api/.env
npm run db:up                        # PostgreSQL en el puerto 5433
npm run db:migrate                   # crea las tablas
npm run db:excel                     # (re)genera data/datos_ficticios.xlsx (opcional: ya está en el repositorio)
npm run db:seed                      # carga los datos ficticios (es idempotente)

npm run dev:api                      # http://localhost:3000
npm run dev:web                      # http://localhost:5173
```

Usuarios de demostración (clave **`Demo2026!`**, solo para desarrollo): `admin`, `jefe`, `coordinador`, `auxiliar1`, `auxiliar2`, `auditor`.

## Pruebas

```bash
npm test          # API: salud, autenticación y catálogo (requiere la base de datos levantada)
npm run typecheck # los tres paquetes
```

## Reglas del dominio que el código debe respetar

Kardex inmutable, existencia derivada de los movimientos, no-negativo sin excepción, SKU y ubicación únicos, piezas con cantidad propia (DOMAIN_MODEL IN-01…IN-79). Se aplican **en la base de datos** y en la transacción que escribe el movimiento, no solo en el código (ADR-001 §3).

## Lo que este esqueleto todavía NO tiene

- Bloqueo de cuenta tras cinco intentos fallidos y cambio de contraseña (HU-ACC-001/003).
- Bitácora de auditoría (HU-AUD-001) y gestión de usuarios y roles (M-02).
- Crear o editar referencias; estructura de bodega editable; QR; entradas, kardex, movimientos y salidas (bloques C1-2 a C1-6).
- Retención local y sincronización sin conectividad (fuera del corte C1).
