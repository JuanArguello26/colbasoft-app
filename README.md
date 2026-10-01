# COLBASOFT · Aplicación

Plataforma de trazabilidad de inventarios para PYMES textiles (proyecto de grado). Este repositorio contiene **el código**; los documentos (SPEC, SRS, dominio, arquitectura) están en el repositorio `colbasoft-docs`.

> **Estado:** corte de entrega **C1** (SPEC v1.5 §12.7). **Bloques C1-1 (Fundación), C1-2 (Identificación y lotes), C1-3 (Entradas, piezas y ubicación), C1-4 (Kardex y consulta de existencia) C1-5 (Movimientos internos) y C1-6 (Salidas y corte parcial) completos: **el corte C1 está construido** (35 de 35 historias); quedan la revisión de las decisiones de interpretación y las pruebas finales.
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

## Estado del bloque C1-4 (Kardex y consulta de existencia)

| Historia | Qué hay |
|---|---|
| HU-INV-001 | Existencia por referencia (texto, lote o ubicación), desglosada por talla, color y lote, con los cinco estados (reservado, inmovilizado y en tránsito valen 0 hasta C1-6 y siguientes); la cifra se suma siempre de los asientos del kardex |
| HU-INV-002 | El escaneo (ya hecho en C1-2) devuelve referencia, talla, color, lote, ubicación y existencia; sin costos; no modifica nada (verificado por prueba) |
| HU-INV-003 | «Dónde está»: todas las ubicaciones con existencia de la referencia, orden por cantidad o zona, filtro por talla, color y lote, y marca de lo no disponible |
| HU-KDX-001 | Kardex de una pieza, un lote o una unidad (SKU + lote + ubicación) en orden cronológico, con fecha, tipo, cantidad, existencia resultante, ubicación, usuario, documento y motivo; verificación de continuidad; exportable a CSV (queda en la bitácora) |
| HU-KDX-002 | Sin ruta ni función para editar o borrar un movimiento (la base también lo rechaza); un error se neutraliza con una **anulación** (movimiento inverso con motivo tipificado, solo Administrador y Jefe); ambos quedan visibles y en la bitácora |
| HU-KDX-006 | Piezas de un lote con tipo, cantidad actual, ubicación y estado; kardex por pieza sin necesidad de un QR propio |

Una migración (`c1_4_kardex_anulacion`) añade el tipo `ANULACION` y las columnas `anulaAId` (único: un movimiento se anula una sola vez) y `motivoId`, con un CHECK que obliga a toda anulación a decir qué neutraliza y con qué motivo.

## Estado del bloque C1-5 (Movimientos internos)

| Historia | Qué hay |
|---|---|
| HU-MOV-001 | Se escanea la mercancía y luego la ubicación destino (o se elige a mano: identificación manual) y se registra un movimiento interno; se mueve la pieza completa, el total no cambia, queda en el kardex y la pantalla confirma |
| HU-MOV-002 | Rechaza mover más de lo que hay, destino igual al origen, destino inactivo, sin capacidad o de la zona de recepción, y existencia no disponible; cada rechazo explica el motivo en lenguaje llano |
| HU-MOV-008 | Tras escanear el QR del SKU + Lote se listan las piezas del lote; la ubicación de origen filtra y verifica; no se confirma sin pieza seleccionada; el kardex guarda la pieza |

Un movimiento interno es un solo movimiento con dos asientos (−origen, +destino) en una transacción. Dos movimientos simultáneos de la misma pieza: solo uno se aplica (el candado de la base de datos rechaza el segundo y se explica). Un movimiento interno se corrige con una anulación (C1-4).

## Estado del bloque C1-6 (Salidas y corte parcial)

| Historia | Qué hay |
|---|---|
| HU-SAL-001 | Solicitar una salida con motivo tipificado de la lista de salidas (nunca cliente, precio ni factura), con referencias, tallas, colores, lotes y cantidades; verifica la existencia disponible antes de aceptar |
| HU-SAL-004 | Nada que deje la existencia negativa (también en la base); si lo disponible no alcanza, rechaza, informa cuánto hay, deja el rechazo en la bitácora y ofrece una salida parcial por lo disponible, que autoriza el Jefe |
| HU-SAL-002 | Al autorizar (Jefe o Administrador) la cantidad pasa a **reservada** en el kardex y deja de contar como disponible; otra salida o un movimiento sobre esa pieza se rechaza; la reserva se libera al cancelar o al vencer su plazo (parámetro `plazo_reserva_horas`) |
| HU-SAL-003 | Indica de qué ubicación y qué piezas tomar según la política configurada (`politica_toma`: 1 = primero en entrar primero en salir por lote; 2 = ubicación de mayor cantidad); el escaneo que no corresponde se rechaza diciendo si difiere la referencia, la talla, el color o el lote; el progreso se ve; confirma al completar |
| HU-SAL-008 | El escaneo verifica y cuenta: cada pieza se cuenta una sola vez (seleccionarla de nuevo no suma); no se confirma completa si falta, salvo salida parcial autorizada; cada pieza tomada queda en el kardex |
| HU-SAL-009 | Corte parcial: se toma solo una parte de una pieza, que conserva su identidad y su remanente, sin superar lo que tiene ni lo reservado; queda como salida con motivo, autorización y atribución, y el remanente se ve de inmediato |

Reservar, sacar y liberar son movimientos del kardex (`RESERVA`, `SALIDA`, `LIBERACION`) con el estado de existencia `RESERVADO`; las tablas `Salida`, `LineaSalida`, `ReservaSalida` y `TomaSalida` solo guardan el plan y lo tomado. Una restricción de la base (`Movimiento_origen_coherente`) obliga a que cada salida lleve su motivo y cada reserva, salida y liberación su documento.

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
- **Decisiones de interpretación del bloque C1-4** (revisar con el Director):
  - **Anulación (RF-KDX-004):** la «autorización» se entendió como el rol (matriz: Administrador y Jefe); no hay una segunda persona que apruebe, porque el SRS no la pide. Una anulación no se anula, y un movimiento ya movido no se anula hasta anular lo posterior (la base rechaza dejar la existencia negativa).
  - **Anular una entrada no cambia el estado del documento de entrada** (sigue «confirmado»); el kardex refleja la anulación. Queda abierto qué debe mostrar el documento.
  - **Motivo en el kardex:** solo las anulaciones llevan motivo; entradas y movimientos internos muestran tipo y documento, porque el SRS no define motivo para ellos.
  - **«Sin huecos» (HU-KDX-001 criterio 4):** se verifica que cada línea sea la anterior más su cantidad y que la existencia no baje de cero. La numeración de movimientos puede saltar (secuencias consumidas por transacciones deshechas) y no se considera hueco.
  - **Kardex del Auxiliar:** solo lo que él movió y los últimos 30 días (matriz de permisos, «Consultar kardex»); los demás roles ven todo.
  - **Existencia resultante** es el acumulado dentro de lo consultado (pieza, lote o unidad); dentro de un movimiento, el origen se lista antes que el destino.
  - La anulación con evidencia (`exigeEvidencia`) no está soportada: los motivos de anulación sembrados no la exigen.
- **Decisiones de interpretación del bloque C1-5** (revisar con el Director):
  - **Solo se mueve existencia disponible.** La existencia «en recepción» se ubica desde la entrada (RN-MOV-010); el rechazo por existencia **inmovilizada** (RF-MOV-006) no se puede ejercitar porque ese estado llega después del corte.
  - **La zona de recepción no es destino** de un movimiento interno: lo ya disponible no vuelve a «en recepción» (RN-EXI-007). El SRS no lo dice de forma expresa.
  - **No hay propuesta ni desviación** en el movimiento interno: RN-MOV-001/003 solo se definen para la primera ubicación.
  - **La cantidad es opcional en la API:** si se envía, debe ser la de la pieza completa; más es «más de lo existente» (RN-EXI-003) y menos es un corte parcial, que se registra como salida (RN-MOV-012, C1-6).
  - **Permisos:** Administrador, Jefe, Coordinador y Auxiliar pueden mover; el Auditor no. La matriz del SRS solo nombra al Auxiliar para esta historia.
- **Decisiones de interpretación del bloque C1-6** (revisar con el Director):
  - **Solo el Jefe y el Administrador autorizan.** El umbral de autorización del Coordinador (RF-SAL-006, HU-SAL-007) está fuera del corte C1: toda salida espera al Jefe.
  - **La reserva se asigna por pieza al autorizar**, con la política de toma (RN-SAL-003); puede reservar solo una parte de una pieza (corte parcial). La política «ubicación más próxima» no existe: el sistema no modela distancias. El parámetro `politica_toma` (1 o 2) lo añadió este bloque; el SRS no fija sus valores.
  - **Salida parcial:** se pide con una confirmación explícita («aceptar parcial»); el sistema reduce cada línea a lo disponible y marca la salida. Esa marca es lo que permite confirmarla incompleta (RN-SAL-009: «salvo salida parcial autorizada»). Lo reservado y no tomado vuelve a disponible.
  - **Un corte menor que lo reservado** se permite al preparar, pero deja la salida incompleta (no se confirma sin parcial). Lo que supera la pieza o lo reservado se rechaza.
  - **Una pieza reservada, en todo o en parte, no se mueve** hasta que la salida se confirme o se cancele (moverla sería dividirla, RN-MOV-012).
  - **Las reservas y salidas no se anulan:** se cancelan mientras estén autorizadas; lo que ya salió solo vuelve como entrada nueva (RN-SAL-007, HU-SAL-006, fuera del corte).
  - **Vencimiento:** la liberación se hace al consultar u operar y con un temporizador del servidor cada minuto. La **alerta al solicitante** (RF-SAL-014) necesita el módulo de alertas, fuera del corte: hoy queda en la bitácora y la salida figura «vencida». El movimiento de liberación se atribuye a «sistema».
  - **Motivos que exigen evidencia** (p. ej. baja por daño): se exige una observación; adjuntar evidencia y la aprobación específica del Jefe (HU-SAL-005, RN-SAL-006) quedan fuera del corte.
  - **El Auxiliar prepara y confirma;** también pueden hacerlo los demás roles, excepto el Auditor.
- **Lectura con cámara:** usa `getUserMedia` y `jsqr`; exige HTTPS o `localhost`, y no se ha probado con una cámara real (solo la ruta de digitación manual y que el QR generado se decodifique de vuelta).
- Retención local y sincronización sin conectividad: fuera del corte C1.

## Base de datos de pruebas

`npm test` usa la base `colbasoft_test` (se crea sola y solo se le aplican migraciones; las pruebas crean datos con nombres únicos). Para empezar de cero, en su terminal: `npm run db:test:reset` (destructivo, solo toca la base de pruebas).
