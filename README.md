# COLBASOFT · Aplicación

Plataforma de trazabilidad de inventarios para PYMES textiles (proyecto de grado). Este repositorio contiene **el código**; los documentos (SPEC, SRS, dominio, arquitectura) están en el repositorio `colbasoft-docs`.

> **Estado:** corte de entrega **C1** (SPEC v1.5 §12.7). **Bloques C1-1 (Fundación) y C1-2 (Identificación y lotes) completos**; sigue C1-3 (entradas, piezas y ubicación).
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

## Estado del bloque C1-1 (Fundación)

| Historia | Qué hay |
|---|---|
| HU-ACC-001/002 | Inicio de sesión con bloqueo tras intentos fallidos, sesión con cierre por inactividad (aviso previo, tiempo en Parámetros) |
| HU-USR-001/002 | Crear usuarios (cinco roles, clave temporal de un solo uso, cambio obligatorio en el primer acceso); desactivar y reactivar; nunca eliminar |
| HU-CAT-001/002 | Crear y editar referencias, tallas, colores y categorías; SKU generados automáticamente; código único |
| HU-BOD-001/002 | Bodegas, zonas y ubicaciones; zona de recepción obligatoria; capacidad opcional con lista de pendientes |
| HU-PAR-001/002 | Parámetros con rango admisible y registro del valor anterior y nuevo; motivos tipificados por tipo de operación |
| HU-AUD-001 | Bitácora inmutable (la base de datos rechaza UPDATE, DELETE y TRUNCATE), encadenada por huella; filtros, exportación CSV y verificación de continuidad |

## Estado del bloque C1-2 (Identificación y lotes)

| Historia | Qué hay |
|---|---|
| HU-LOT-001 | Lotes con origen y fecha de ingreso; código único dentro del SKU (también bajo peticiones simultáneas); consulta con filtros |
| HU-QRC-001 | Un identificador QR único por SKU + Lote, activo al nacer, que no depende de la ubicación; impresión individual o por lote de impresión, con referencia, talla, color y lote legibles |
| HU-QRC-002 | Resolución de un código escaneado (cámara de la tablet) o digitado: muestra SKU + Lote y ubicaciones con existencia; desconocido → ofrece novedad; anulado → rechaza; respuesta bien por debajo de 2 s (RNF-REN-002) |
| HU-QRC-003 | (Should, adelantada) QR propio por ubicación, por ubicación o por zona completa, distinguible del de mercancía (`COL-U-…` frente a `COL-M-…`); cierra HU-BOD-001 criterio 5 |

La base de datos garantiza RN-IDE-002: un identificador emitido no se borra, no cambia de valor ni se reactiva tras anularse (disparadores en la migración `c1_2_identificacion`). El valor del QR es opaco; el alfabeto excluye los pares que se confunden al digitar a mano (0/O, 1/I/L, 8/B, 5/S, 2/Z).

Las pantallas se ven según el rol (SPEC §2.7): el Jefe consulta parámetros y bitácora (sin eventos de configuración), el Coordinador solo su umbral, el Auditor solo la bitácora.

## Provisional o pendiente

- **Parámetros y rangos:** son valores **de demostración**; el SPEC no fija cifras (se calibran con datos reales).
- **Política de contraseñas:** provisional (8 caracteres, letras y números, sin el usuario); el SPEC no la define.
- **Notificación al Administrador** por cuenta bloqueada (RF-ACC-004): queda el evento en la bitácora y la marca «Bloqueado» en Usuarios; la notificación llega con el módulo M-20. El desbloqueo (HU-ACC-004) se anticipó por necesidad.
- **Reglas que dependen del kardex** (RN-004, RN-013, RN-MAE-003): el código ya las valida, pero hoy no hay movimientos ni existencia; tres pruebas están marcadas como pendientes y se activan en el bloque C1-3.
- **Conservar el registro en curso al expirar la sesión** (HU-ACC-002, criterio 4): se comprueba cuando existan formularios de registro (C1-3).
- **Lotes creados a mano:** hasta C1-3 el lote se crea desde «Lotes y QR»; con las entradas se creará o asociará al confirmar la entrada (HU-LOT-001 criterios 1 y 4, `it.todo`). El *origen* es texto libre mientras no exista el documento de entrada.
- **Anulación y reimpresión de identificadores** (HU-QRC-004): fuera del corte C1. El estado «anulado» ya se respeta al escanear, pero la API aún no ofrece anular.
- **Modo de identificación por movimiento** (RF-QRC-009, escaneo o manual): la resolución ya lo recibe y lo registra si el código no se reconoce; guardarlo en cada movimiento llega con C1-3.
- **Lectura con cámara:** usa `getUserMedia` y `jsqr`; exige HTTPS o `localhost`, y no se ha probado con una cámara real (solo la ruta de digitación manual y que el QR generado se decodifique de vuelta).
- Retención local y sincronización sin conectividad: fuera del corte C1.

## Base de datos de pruebas

`npm test` usa la base `colbasoft_test` (se crea sola y solo se le aplican migraciones; las pruebas crean datos con nombres únicos). Para empezar de cero, en su terminal: `npm run db:test:reset` (destructivo, solo toca la base de pruebas).
