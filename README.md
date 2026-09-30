# COLBASOFT · Aplicación

Plataforma de trazabilidad de inventarios para PYMES textiles (proyecto de grado). Este repositorio contiene **el código**; los documentos (SPEC, SRS, dominio, arquitectura) están en el repositorio `colbasoft-docs`.

> **Estado:** corte de entrega **C1** (SPEC v1.5 §12.7). **Bloque C1-1 (Fundación) completo**; siguen C1-2 (QR y lotes) y los demás.
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

Las pantallas se ven según el rol (SPEC §2.7): el Jefe consulta parámetros y bitácora (sin eventos de configuración), el Coordinador solo su umbral, el Auditor solo la bitácora.

## Provisional o pendiente

- **Parámetros y rangos:** son valores **de demostración**; el SPEC no fija cifras (se calibran con datos reales).
- **Política de contraseñas:** provisional (8 caracteres, letras y números, sin el usuario); el SPEC no la define.
- **Notificación al Administrador** por cuenta bloqueada (RF-ACC-004): queda el evento en la bitácora y la marca «Bloqueado» en Usuarios; la notificación llega con el módulo M-20. El desbloqueo (HU-ACC-004) se anticipó por necesidad.
- **Identificador QR de ubicaciones** (HU-BOD-001, criterio 5): llega con el bloque C1-2.
- **Reglas que dependen del kardex** (RN-004, RN-013, RN-MAE-003): el código ya las valida, pero hoy no hay movimientos ni existencia; tres pruebas están marcadas como pendientes y se activan en el bloque C1-3.
- **Conservar el registro en curso al expirar la sesión** (HU-ACC-002, criterio 4): se comprueba cuando existan formularios de registro (C1-3).
- Retención local y sincronización sin conectividad: fuera del corte C1.

## Base de datos de pruebas

`npm test` usa la base `colbasoft_test` (se crea sola y solo se le aplican migraciones; las pruebas crean datos con nombres únicos). Para empezar de cero, en su terminal: `npm run db:test:reset` (destructivo, solo toca la base de pruebas).
