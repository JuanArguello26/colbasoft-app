import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MotivoVista, ParametroVista } from "@colbasoft/shared";
import { prisma } from "../src/db.js";
import { entrar, iniciarApp, pedir, unico } from "./ayuda.js";

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await iniciarApp();
  admin = await entrar(app, "admin");
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("HU-PAR-001 · parámetros de configuración", () => {
  it("criterios 1 y 3: el Administrador modifica y el cambio queda con valor anterior y nuevo", async () => {
    const antes = ((await pedir(app, admin, "GET", "/api/parametros")).json() as ParametroVista[]).find((p) => p.clave === "tolerancia_conteo_pct")!;
    const nuevo = antes.valor === 3 ? 4 : 3;
    const r = await pedir(app, admin, "PUT", "/api/parametros/tolerancia_conteo_pct", { valor: nuevo });
    expect(r.statusCode).toBe(200);
    const reg = await prisma.registroBitacora.findFirstOrThrow({ where: { evento: "parametro_modificado", entidadId: "tolerancia_conteo_pct" }, orderBy: { seq: "desc" } });
    expect(reg.detalle).toMatchObject({ clave: "tolerancia_conteo_pct", anterior: antes.valor, nuevo });
  });

  it("criterio 2 (RF-PAR-002): rechaza valores fuera del rango admisible con una explicación", async () => {
    const r = await pedir(app, admin, "PUT", "/api/parametros/intentos_bloqueo", { valor: 0 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/entre/);
    expect((await pedir(app, admin, "PUT", "/api/parametros/intentos_bloqueo", { valor: 3.5 })).statusCode).toBe(422); // debe ser entero
    expect((await pedir(app, admin, "PUT", "/api/parametros/no_existe", { valor: 1 })).statusCode).toBe(404);
  });

  it("criterio 4 (RF-PAR-004): el cambio rige hacia adelante: la siguiente consulta ya usa el valor nuevo", async () => {
    await pedir(app, admin, "PUT", "/api/parametros/aviso_inactividad_segundos", { valor: 45 });
    const jefe = await entrar(app, "jefe");
    const yo = (await pedir(app, jefe, "GET", "/api/auth/yo")).json() as { avisoSegundos: number };
    expect(yo.avisoSegundos).toBe(45);
    await pedir(app, admin, "PUT", "/api/parametros/aviso_inactividad_segundos", { valor: 60 });
  });

  it("DEC-04: el Jefe consulta sin modificar; el Coordinador solo ve su umbral; los demás no ven nada", async () => {
    const jefe = await entrar(app, "jefe");
    expect(((await pedir(app, jefe, "GET", "/api/parametros")).json() as unknown[]).length).toBeGreaterThan(5);
    expect((await pedir(app, jefe, "PUT", "/api/parametros/umbral_ajuste", { valor: 10 })).statusCode).toBe(403);
    const coord = await entrar(app, "coordinador");
    const suyo = (await pedir(app, coord, "GET", "/api/parametros")).json() as ParametroVista[];
    expect(suyo.map((p) => p.clave)).toEqual(["umbral_autorizacion_coordinador"]);
    expect((await pedir(app, await entrar(app, "auxiliar2"), "GET", "/api/parametros")).statusCode).toBe(403);
  });
});

describe("HU-PAR-002 · motivos tipificados", () => {
  it("criterios 1 y 2: se administran por tipo de operación e indican si exigen evidencia", async () => {
    const nombre = unico("Motivo de prueba ");
    const r = await pedir(app, admin, "POST", "/api/motivos", { tipoOperacion: "AJUSTE", nombre, exigeEvidencia: true });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ tipoOperacion: "AJUSTE", exigeEvidencia: true, activo: true });
    expect((await pedir(app, admin, "POST", "/api/motivos", { tipoOperacion: "AJUSTE", nombre })).statusCode).toBe(409);
    expect((await pedir(app, admin, "POST", "/api/motivos", { tipoOperacion: "OTRO", nombre: "xxx yyy" })).statusCode).toBe(422);
  });

  it("criterios 3 y 4 (RN-063): un motivo se desactiva, no se elimina; el desactivado no se ofrece, pero existe en el histórico", async () => {
    const nombre = unico("Motivo a retirar ");
    const creado = (await pedir(app, admin, "POST", "/api/motivos", { tipoOperacion: "SALIDA", nombre })).json() as MotivoVista;
    expect((await pedir(app, admin, "POST", `/api/motivos/${creado.id}/desactivar`)).statusCode).toBe(200);

    const coord = await entrar(app, "coordinador");
    const visiblesParaOperar = (await pedir(app, coord, "GET", "/api/motivos")).json() as MotivoVista[];
    expect(visiblesParaOperar.some((m) => m.id === creado.id)).toBe(false);
    const todos = (await pedir(app, admin, "GET", "/api/motivos")).json() as MotivoVista[];
    expect(todos.find((m) => m.id === creado.id)?.activo).toBe(false);
    expect(await prisma.motivo.findUnique({ where: { id: creado.id } })).not.toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/api/motivos/${creado.id}`, cookies: { token: admin } })).statusCode).toBe(404);

    expect((await pedir(app, admin, "POST", `/api/motivos/${creado.id}/reactivar`)).statusCode).toBe(200);
  });

  it("solo el Administrador los administra", async () => {
    const jefe = await entrar(app, "jefe");
    expect((await pedir(app, jefe, "POST", "/api/motivos", { tipoOperacion: "AJUSTE", nombre: "Un motivo cualquiera" })).statusCode).toBe(403);
  });

  it("los datos ficticios traen motivos de los cuatro tipos de operación", async () => {
    const tipos = new Set(((await pedir(app, admin, "GET", "/api/motivos")).json() as MotivoVista[]).map((m) => m.tipoOperacion));
    expect([...tipos].sort()).toEqual(["AJUSTE", "ANULACION", "DESCARTE_ALERTA", "SALIDA"]);
  });
});
