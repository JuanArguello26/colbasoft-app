import { execSync } from "node:child_process";
import { urlPrueba } from "./urlPrueba.js";

/**
 * Deja la base de pruebas al día con las migraciones (incluidos los disparadores de la bitácora).
 * Usa `migrate deploy`: solo aplica migraciones pendientes y no destruye datos. Las pruebas no necesitan una base vacía:
 * crean datos con nombres únicos. Para empezar de cero, el desarrollador ejecuta `npm run db:test:reset` en su terminal.
 */
export default function preparar() {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: urlPrueba() },
    stdio: "pipe",
  });
}
