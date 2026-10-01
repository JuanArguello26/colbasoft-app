# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Contexto

Código de COLBASOFT (trazabilidad de inventarios para PYMES textiles; proyecto de grado). Los documentos que mandan sobre el código (SPEC, SRS, modelo de dominio, ADR) están en el repositorio hermano `../colbasoft-docs`; el ID que aparece en comentarios y pruebas (`HU-…`, `RF-…`, `RN-…`, `RNF-…`, `IN-…`) se busca allí. Stack fijado en `colbasoft-docs/07_FASE_5_ARQUITECTURA/ADR-001_PILA_TECNOLOGICA.md`. Todo el código, comentarios, mensajes y documentación van **en español**.

Estado: corte de entrega C1 (SPEC v1.5 §12.7). C1-1 a C1-4 (Fundación, identificación y lotes, entradas/piezas/ubicación, kardex y consulta de existencia) completos; siguen C1-5 (movimientos internos) y C1-6 (salidas). Se valida **solo con datos ficticios**; el Excel es únicamente carga de datos de prueba, la base real es PostgreSQL.

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
- **Identificadores QR** (`src/identificadores.ts`, `routes/identificadores.ts`, `routes/lotes.ts`): el QR de mercancía identifica SKU + Lote (DF5-01) y el de ubicación a la ubicación; el valor es opaco y aleatorio, con prefijo `COL-M-`/`COL-U-` que los distingue. Triggers de la migración `c1_2_identificacion` impiden borrar, reasignar o reactivar un identificador (RN-IDE-002); el CHECK `Identificador_tipo_coherente` liga cada tipo a su lote o ubicación. Las etiquetas se generan en el servidor (SVG) y se imprimen con la impresión del navegador (CSS `@media print`).
- **Kardex y existencia** (`prisma/schema.prisma`: `Movimiento`, `AsientoKardex`; `src/inventario.ts`): un movimiento tiene uno o más asientos (pieza, ubicación, estado, delta con signo). La existencia **no se guarda**: se suma de los asientos (RN-INT-004), así que cualquier cantidad nueva sale de una consulta sobre `AsientoKardex`, nunca de una columna. Triggers de `c1_3_entradas_kardex`: el kardex es inmutable y un asiento no puede dejar la suma de (pieza, ubicación, estado) por debajo de cero (candado `pg_advisory_xact_lock` por clave, para que operaciones simultáneas no se salten la regla). Un movimiento con varios asientos (p. ej. el interno: −origen, +destino) se escribe en **una sola transacción**.
- **Entradas** (`src/entradas.ts`, `routes/entradas.ts`): documento → líneas (un SKU cada una) → piezas (rollo/paquete/bolsa, cantidad propia e inmutable). El lote se asigna a la línea al confirmar. Estados SM-08; la recepción se cierra explícitamente. Confirmar crea el movimiento `ENTRADA` con la existencia `EN_RECEPCION`; ubicar es un `MOVIMIENTO_INTERNO` (−recepción, +destino `DISPONIBLE`, o `EN_RECEPCION` si el destino es zona de recepción). La propuesta de ubicación (`proponerUbicacion`) usa `Zona.categoriaId` y la capacidad solo si coincide la unidad. Los rechazos de negocio se lanzan como `ErrorHttp` dentro de la transacción para que deshaga todo (`manejar` en `routes/entradas.ts`).
- **Consultas y anulación** (`src/consultas.ts`, `routes/inventario.ts` bajo `/api/inventario`): existencia por referencia (`consultarExistencia`), `dondeEsta` y `consultarKardex` (existencia resultante con `SUM() OVER`, restricción del Auxiliar aplicada *después* del acumulado). Anular = movimiento `ANULACION` con asientos de signo contrario, `anulaAId` único y motivo; el CHECK `Movimiento_anulacion_coherente` y el trigger de no-negativo hacen el resto. Un enum nuevo de Postgres no se puede usar en la misma migración que lo crea: castear a `::text` en los CHECK.
- **`src/inventario.ts`**: consultas del kardex (`referenciaTieneMovimientos`, `referenciaTieneExistencia`, `ubicacionTieneExistencia`, `ubicacionesConExistencia`, `existenciaDePiezas`, `ocupacionEnUnidad`).
- **Migraciones**: `apps/api/prisma/migrations/`. Cambios que Prisma no expresa (triggers, funciones) se escriben a mano en el `migration.sql`.
- **Cliente web, cabecera JSON:** `apps/web/src/api.ts` solo envía `Content-Type: application/json` cuando hay cuerpo; Fastify responde 400 a un POST sin cuerpo con esa cabecera (así fallaba «Salir»). Las pruebas con `app.inject` no lo detectan: los botones sin cuerpo (logout, desactivar, cerrar recepción…) hay que probarlos en el navegador.
- **Datos ficticios**: `scripts/generar-excel.ts` → `data/datos_ficticios.xlsx` → `scripts/cargar-excel.ts` (+ `src/datos/`).

## Reglas de trabajo

- No inventar funcionalidad ni cifras: parámetros, rangos y política de contraseñas son **provisionales** (el SPEC no los fija; ver README «Provisional o pendiente»). Si el código contradice un documento, registrarlo y escalarlo, no «arreglarlo» en silencio.
- Vocabulario controlado (GLOSSARY): Ubicación, Movimiento, Ajuste, Conteo, Existencia, Referencia, Bitácora; no usar stock/saldo/posición/transacción.
- Sin módulos de ventas, compras, producción, contabilidad ni **ninguna** IA; sin campos de dinero (valorización retirada del MVP).
