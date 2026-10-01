# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Contexto

Código de COLBASOFT (trazabilidad de inventarios para PYMES textiles; proyecto de grado). Los documentos que mandan sobre el código (SPEC, SRS, modelo de dominio, ADR) están en el repositorio hermano `../colbasoft-docs`; el ID que aparece en comentarios y pruebas (`HU-…`, `RF-…`, `RN-…`, `RNF-…`, `IN-…`) se busca allí. Stack fijado en `colbasoft-docs/07_FASE_5_ARQUITECTURA/ADR-001_PILA_TECNOLOGICA.md`. Todo el código, comentarios, mensajes y documentación van **en español**.

Estado: corte de entrega C1 (SPEC v1.5 §12.7). C1-1 (Fundación) completo; siguen C1-2 (QR y lotes), C1-3 (entradas/piezas/ubicación), C1-4 (kardex), C1-5 (movimientos internos), C1-6 (salidas). Se valida **solo con datos ficticios**; el Excel es únicamente carga de datos de prueba, la base real es PostgreSQL.

## Comandos

Monorepo `npm workspaces` (`apps/api`, `apps/web`, `packages/shared`). Desde la raíz:

```bash
npm install
npm run build -w @colbasoft/shared   # obligatorio una vez (y tras cambiar shared): api y web consumen su dist/
cp .env.example apps/api/.env
npm run db:up                        # PostgreSQL 16 en Docker, puerto 5433
npm run db:migrate                   # prisma migrate dev
npm run db:seed                      # carga data/datos_ficticios.xlsx (idempotente); db:excel lo regenera
npm run dev:api                      # :3000   |   npm run dev:web  # :5173 (proxy /api → :3000)
npm test                             # vitest del API; requiere la BD levantada
npm run typecheck                    # los tres paquetes
npm run build
```

Una sola prueba (desde `apps/api`): `npx vitest run test/bitacora.test.ts` o `npx vitest run -t "texto del caso"`.

`npm test` usa la base `colbasoft_test` (la deriva `test/urlPrueba.ts` de `DATABASE_URL`; `test/preparar-bd.ts` solo aplica `prisma migrate deploy`). Las pruebas no limpian: crean datos con nombres únicos y corren en serie (`fileParallelism: false`). Para empezar de cero: `npm run db:test:reset` (destructivo, solo base de pruebas). Usuarios de demostración (clave `Demo2026!`): `admin`, `jefe`, `coordinador`, `auxiliar1`, `auxiliar2`, `auditor`.

## Arquitectura

- **`packages/shared`**: contrato común API↔web (roles, unidades de medida, tipos de operación, tipos de zona, DTOs como `UsuarioSesion`). Si un enum cambia aquí, también en `prisma/schema.prisma`.
- **`apps/api`** (Fastify 5 + Prisma 6, ESM): `src/app.ts` exporta `construirApp()` (lo usan `server.ts` y las pruebas) y registra un plugin por módulo en `src/routes/*` bajo `/api/<módulo>`. Módulos transversales en `src/`: `bitacora.ts`, `permisos.ts`, `sesion.ts`, `parametros.ts`, `seguridad.ts`, `inventario.ts`.
- **`apps/web`** (React 19 + Vite): una vista por módulo en `src/vistas/`, cliente HTTP en `src/api.ts`. Las pantallas se muestran según el rol.

Mecanismos que cruzan varios archivos:

- **Autenticación** (`app.ts` → `decorate("autenticar")`): JWT en cookie `token`. En *cada* petición se relee al usuario en la BD (desactivar/bloquear corta el acceso al instante y el **rol vigente es el de la BD, no el del token**). Cada petición reemite el token (sesión deslizante con cierre por inactividad, tiempo en Parámetros) salvo las rutas pasivas (`/api/auth/yo`, `/api/salud`). Con `debeCambiarClave` solo se permiten `cambiar-clave`, `yo` y `logout`.
- **Autorización**: usar `requiereRol(...roles)` (`permisos.ts`) como `preHandler`; ya llama a `autenticar` y registra en la bitácora todo intento no autorizado. Son cinco roles fijos; el Auditor nunca escribe inventario.
- **Bitácora inmutable** (`bitacora.ts`): cada registro encadena el SHA-256 del anterior sobre un JSON canónico (llaves ordenadas) y se serializa con un candado asesor de Postgres (`CANDADO`). Triggers en la migración `c1_1_fundacion` hacen que la BD rechace UPDATE/DELETE/TRUNCATE; `verificarContinuidad` detecta cadenas rotas. Toda operación de escritura debe registrar su evento (dentro de la misma transacción con el cliente transaccional; `registrarSuelto` fuera de ella). Nunca se escriben claves en el detalle.
- **Reglas del dominio en la BD, no solo en código** (ADR-001 §3): kardex inmutable, existencia derivada de movimientos, no-negativo sin excepción, SKU y ubicación únicos. Al añadir movimientos (C1-3+) deben aplicarse con restricciones/triggers y en la transacción que escribe el movimiento, como ya se hizo con la bitácora.
- **`src/inventario.ts`**: stubs que hoy devuelven `false` (`referenciaTieneMovimientos`, `referenciaTieneExistencia`, `ubicacionTieneExistencia`). Cuando existan movimientos (C1-3/C1-4), reemplazarlos por consultas reales y activar los `it.todo` de `test/catalogo.test.ts` (RN-004, RN-MAE-003, etc.).
- **Migraciones**: `apps/api/prisma/migrations/`. Cambios que Prisma no expresa (triggers, funciones) se escriben a mano en el `migration.sql`.
- **Datos ficticios**: `scripts/generar-excel.ts` → `data/datos_ficticios.xlsx` → `scripts/cargar-excel.ts` (+ `src/datos/`).

## Reglas de trabajo

- No inventar funcionalidad ni cifras: parámetros, rangos y política de contraseñas son **provisionales** (el SPEC no los fija; ver README «Provisional o pendiente»). Si el código contradice un documento, registrarlo y escalarlo, no «arreglarlo» en silencio.
- Vocabulario controlado (GLOSSARY): Ubicación, Movimiento, Ajuste, Conteo, Existencia, Referencia, Bitácora; no usar stock/saldo/posición/transacción.
- Sin módulos de ventas, compras, producción, contabilidad ni **ninguna** IA; sin campos de dinero (valorización retirada del MVP).
