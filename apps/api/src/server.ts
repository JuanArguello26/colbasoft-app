import { construirApp } from "./app.js";

const puerto = Number(process.env.PORT ?? 3000);
const secreto = process.env.JWT_SECRET;
if (!secreto) {
  console.error("Falta JWT_SECRET. Copie .env.example a apps/api/.env");
  process.exit(1);
}

const app = await construirApp({ jwtSecret: secreto, logger: true });
await app.listen({ port: puerto, host: "0.0.0.0" });
