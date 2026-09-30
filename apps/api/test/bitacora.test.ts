import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { verificarContinuidad } from "../src/bitacora.js";
import { entrar, iniciarApp, pedir, unico, usuarioListo } from "./ayuda.js";

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

describe("RN-061 · la bitácora es inmutable", () => {
  it("la base de datos rechaza UPDATE y DELETE sobre la bitácora, incluso con acceso directo", async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "RegistroBitacora" SET modulo = 'X'`)).rejects.toThrow(/inmutable/i);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "RegistroBitacora"`)).rejects.toThrow(/inmutable/i);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "RegistroBitacora"`)).rejects.toThrow(/inmutable/i);
    expect(await prisma.registroBitacora.count()).toBeGreaterThan(0);
  });

  it("la API no ofrece ninguna ruta para editar o borrar la bitácora", async () => {
    for (const metodo of ["PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method: metodo, url: "/api/bitacora", cookies: { token: admin } })).statusCode).toBe(404);
    }
  });
});

describe("HU-AUD-001 · consulta, continuidad y exportación", () => {
  it("criterio 4: la cadena íntegra no tiene hallazgos", async () => {
    const r = (await pedir(app, admin, "GET", "/api/bitacora/continuidad")).json() as { ok: boolean; registros: number; hallazgos: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.hallazgos).toEqual([]);
    expect(r.registros).toBeGreaterThan(0);
  });

  it("criterio 4: una alteración hecha por fuera de la aplicación se detecta como hallazgo crítico", async () => {
    const ultimo = await prisma.registroBitacora.findFirstOrThrow({ orderBy: { seq: "desc" } });
    // un atacante con acceso a la base de datos desactiva el disparador y altera un registro
    await prisma.$executeRawUnsafe(`ALTER TABLE "RegistroBitacora" DISABLE TRIGGER bitacora_sin_modificar`);
    try {
      await prisma.$executeRawUnsafe(`UPDATE "RegistroBitacora" SET modulo = 'ALTERADO' WHERE seq = ${ultimo.seq}`);
      const r = await verificarContinuidad();
      expect(r.ok).toBe(false);
      expect(r.hallazgos.some((h) => h.seq === String(ultimo.seq))).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE "RegistroBitacora" SET modulo = '${ultimo.modulo}' WHERE seq = ${ultimo.seq}`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "RegistroBitacora" ENABLE TRIGGER bitacora_sin_modificar`);
    }
    expect((await verificarContinuidad()).ok).toBe(true);
  });

  it("criterio 2: filtra por usuario, evento y módulo", async () => {
    await entrar(app, "auxiliar2");
    const r = (await pedir(app, admin, "GET", "/api/bitacora?usuario=auxiliar2&evento=acceso_exitoso&modulo=ACCESO")).json() as Array<{ usuarioLogin: string; evento: string }>;
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.usuarioLogin === "auxiliar2" && x.evento === "acceso_exitoso")).toBe(true);
  });

  it("nunca guarda contraseñas ni claves en el detalle", async () => {
    const todo = JSON.stringify(await prisma.registroBitacora.findMany({ select: { detalle: true, usuarioLogin: true } }));
    expect(todo).not.toMatch(/Demo2026|ClaveNueva2026|passwordHash|claveTemporal/);
  });

  it("criterio 5: se exporta en CSV y la exportación queda registrada (RF-AUD-001)", async () => {
    const auditor = await entrar(app, "auditor");
    const antes = await prisma.registroBitacora.count({ where: { evento: "bitacora_exportada" } });
    const r = await pedir(app, auditor, "GET", "/api/bitacora/exportar?modulo=ACCESO");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.body.split("\n")[0]).toContain("instante");
    expect(await prisma.registroBitacora.count({ where: { evento: "bitacora_exportada" } })).toBe(antes + 1);
  });

  it("SPEC §2.7: el Jefe ve la bitácora sin eventos de configuración; Coordinador y Auxiliar no la ven", async () => {
    await pedir(app, admin, "PUT", "/api/parametros/dias_sin_movimiento", { valor: 91 });
    const jefe = await entrar(app, "jefe");
    const r = (await pedir(app, jefe, "GET", "/api/bitacora?limite=500")).json() as Array<{ modulo: string }>;
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.modulo === "PARAMETROS")).toBe(false);
    expect((await pedir(app, jefe, "GET", "/api/bitacora?modulo=PARAMETROS")).json()).toEqual([]);
    expect((await pedir(app, await entrar(app, "coordinador"), "GET", "/api/bitacora")).statusCode).toBe(403);
    expect((await pedir(app, await entrar(app, "auxiliar1"), "GET", "/api/bitacora")).statusCode).toBe(403);
    // solo Administrador y Auditor exportan
    expect((await pedir(app, jefe, "GET", "/api/bitacora/exportar")).statusCode).toBe(403);
    unico("x");
  });
});

describe("la cadena resiste escrituras concurrentes", () => {
  it("20 eventos en paralelo no rompen la continuidad", async () => {
    // usuario propio: los intentos fallidos lo bloquean y no deben afectar a los usuarios de demostración
    const u = await usuarioListo(app, admin, "AUXILIAR_BODEGA");
    await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: "/api/auth/login", payload: { login: u.login, clave: "incorrecta1" } })));
    expect((await verificarContinuidad()).ok).toBe(true);
  });
});
