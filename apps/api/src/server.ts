import { construirApp } from "./app.js";
import { liberarVencidas } from "./salidas.js";

const puerto = Number(process.env.PORT ?? 3000);
const secreto = process.env.JWT_SECRET;
if (!secreto) {
  console.error("Falta JWT_SECRET. Copie .env.example a apps/api/.env");
  process.exit(1);
}

const app = await construirApp({ jwtSecret: secreto, logger: true });
await app.listen({ port: puerto, host: "0.0.0.0" });

// RN-SAL-005: una reserva que no se ejecuta en su plazo se libera sola. Además de revisarse al consultar y al operar, se revisa cada minuto.
setInterval(() => { liberarVencidas().catch((e) => app.log.error(e, "No se pudieron liberar las reservas vencidas")); }, 60_000).unref();
