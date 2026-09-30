import { defineConfig } from "vitest/config";

// Las pruebas usan la base de datos local (npm run db:up) y las variables de apps/api/.env.
try {
  process.loadEnvFile(".env");
} catch {
  /* sin .env: se usan las variables del entorno */
}

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
