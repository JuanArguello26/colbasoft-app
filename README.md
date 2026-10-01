# COLBASOFT · Aplicación

Plataforma de trazabilidad de inventarios para PYMES textiles (proyecto de grado). Este repositorio contiene **el código**; los documentos (SPEC, SRS, dominio, arquitectura) están en el repositorio `colbasoft-docs`.

> **Estado:** corte de entrega **C1** (SPEC v1.5 §12.7). **Bloques C1-1 (Fundación), C1-2 (Identificación y lotes) y C1-3 (Entradas, piezas y ubicación) completos**; sigue C1-4 (kardex y consulta de existencia).
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

## Estado del bloque C1-3 (Entradas, piezas y ubicación)

| Historia | Qué hay |
|---|---|
| HU-ENT-001 | Documento de entrada con origen, fecha esperada y líneas (SKU y cantidad); queda pendiente de recepción; sin precio ni datos comerciales; solo referencias activas; advierte de posible duplicado y exige confirmación |
| HU-ENT-002 + HU-ENT-009 | Recepción desde la tablet **por piezas** (rollo, paquete o bolsa, con cantidad propia); la cantidad de la línea es la suma de sus piezas; confirmación visible de cada pieza; la continúa otro usuario y quedan ambos registrados; instante de llegada |
| HU-ENT-004 | Comparación línea por línea: conforme, faltante (queda registrado, no bloquea) o sobrante (lo autoriza el Jefe antes de confirmar); la diferencia queda en el documento |
| HU-ENT-003 + HU-LOT-001 (criterios 1 y 4) | Confirma una segunda persona (nunca quien recibió); crea o asocia el lote; genera el movimiento de entrada en el **kardex**; la existencia queda **en recepción**, no disponible |
| HU-ENT-006 | Propuesta de ubicación con regla fija (zona por categoría, agrupación por referencia, mayor capacidad libre; si nada aplica, recepción); confirma escaneando mercancía y luego ubicación; la desviación se permite y se registra; valida que el destino esté activo y con capacidad |

El kardex (`Movimiento` y `AsientoKardex`) es inmutable y la existencia **nunca se guarda**: se suma siempre de los asientos (RN-INT-004). La base de datos rechaza editar o borrar el kardex y rechaza dejar la existencia de una pieza en una ubicación por debajo de cero, también con operaciones simultáneas (RN-EXI-001). La primera ubicación es un movimiento interno desde recepción hacia el destino (RN-MOV-010). Con el kardex ya existen las tres reglas que esperaban: RN-004, RN-MAE-003 y RN-013.

Las pantallas se ven según el rol (SPEC §2.7): el Jefe consulta parámetros y bitácora (sin eventos de configuración), el Coordinador solo su umbral, el Auditor solo la bitácora.

## Provisional o pendiente

- **Parámetros y rangos:** son valores **de demostración**; el SPEC no fija cifras (se calibran con datos reales).
- **Política de contraseñas:** provisional (8 caracteres, letras y números, sin el usuario); el SPEC no la define.
- **Notificación al Administrador** por cuenta bloqueada (RF-ACC-004): queda el evento en la bitácora y la marca «Bloqueado» en Usuarios; la notificación llega con el módulo M-20. El desbloqueo (HU-ACC-004) se anticipó por necesidad.
- **Conservar el registro en curso al expirar la sesión** (HU-ACC-002, criterio 4): se comprueba cuando existan formularios de registro (C1-3).
- **Lote creado a mano:** además de crearse al confirmar una entrada, se puede crear desde «Lotes y QR» (útil para pruebas). El *origen* del lote es texto libre; al confirmar una entrada, por defecto es el origen del documento.
- **Anulación y reimpresión de identificadores** (HU-QRC-004): fuera del corte C1. El estado «anulado» ya se respeta al escanear, pero la API aún no ofrece anular.
- **Modo de identificación por movimiento** (RF-QRC-009): se guarda en cada movimiento interno (escaneo si se escanearon mercancía y ubicación; manual en otro caso). El movimiento de entrada no lo lleva: no hay escaneo en la confirmación.
- **Decisiones de interpretación del bloque C1-3** (el SRS no las fija; revisar con el Director):
  - **Cerrar la recepción** es una acción explícita del Auxiliar: el SM-08 no dice qué dispara un faltante. Mientras está abierta, lo que falta figura «en curso»; al cerrar pasa a faltante. El sobrante se marca al registrarlo, pero el documento pasa a «recibido con novedad» al cerrar.
  - **Notificaciones** (faltante al Jefe, desviación al Coordinador): la notificación llega con el módulo M-20. Hoy quedan en la bitácora y a la vista (insignias de faltante y sobrante en la lista, y la lista «Desviaciones de ubicación»).
  - **Zona por categoría:** el criterio de la propuesta (H-19) necesita saber qué categoría recibe cada zona, y ningún documento lo define. Se añadió esa configuración en Bodega (solo Administrador); una zona sin categoría no se propone por ese criterio.
  - **Capacidad:** solo limita cuando está en la misma unidad que la mercancía (no hay conversión, RN-INT-007); la ocupación con unidades mezcladas sigue abierta (HD-17). La precisión es de tres decimales (HD-18, provisional).
  - **Cuarentena** no es destino de mercancía conforme (es para la inmovilizada, RN-ENT-006, fuera del corte).
  - **Una pieza no se edita ni se elimina** (RN-LOT-007, RN-MAE-007): si se digita mal una cantidad antes de confirmar no hay corrección en el sistema. El estado «Reversado» del documento (HD-19) no tiene requisito y no se implementó. Es el hueco más molesto de la recepción: conviene decidirlo.
  - **El lote se asigna al confirmar:** las piezas pertenecen a una línea (un SKU) y por ella a un solo lote.
  - Una línea por SKU en cada documento.
- **Lectura con cámara:** usa `getUserMedia` y `jsqr`; exige HTTPS o `localhost`, y no se ha probado con una cámara real (solo la ruta de digitación manual y que el QR generado se decodifique de vuelta).
- Retención local y sincronización sin conectividad: fuera del corte C1.

## Base de datos de pruebas

`npm test` usa la base `colbasoft_test` (se crea sola y solo se le aplican migraciones; las pruebas crean datos con nombres únicos). Para empezar de cero, en su terminal: `npm run db:test:reset` (destructivo, solo toca la base de pruebas).
