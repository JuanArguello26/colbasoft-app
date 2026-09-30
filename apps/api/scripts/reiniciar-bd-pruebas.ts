/**
 * Recrea la base de pruebas desde cero. ES DESTRUCTIVO (solo toca colbasoft_test, nunca la de desarrollo).
 * Lo ejecuta el desarrollador en su terminal: `npm run db:test:reset`.
 */
import { execSync } from "node:child_process";
import { urlPrueba } from "../test/urlPrueba.js";

const url = urlPrueba();
if (!url.includes("colbasoft_test")) throw new Error("La URL no apunta a la base de pruebas; se cancela.");
execSync("npx prisma migrate reset --force --skip-seed --skip-generate", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
