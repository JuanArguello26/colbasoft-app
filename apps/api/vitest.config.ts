import { defineConfig } from "vitest/config";
import { urlPrueba } from "./test/urlPrueba.js";

// Las pruebas usan la base de datos local (npm run db:up) y las variables de apps/api/.env.
try {
  process.loadEnvFile(".env");
} catch {
  /* sin .env: se usan las variables del entorno */
}

export default defineConfig({
  test: {
    env: { DATABASE_URL: urlPrueba() },
    globalSetup: ["./test/preparar-bd.ts"],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
