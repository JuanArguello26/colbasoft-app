import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En desarrollo, /api se reenvía al servidor (puerto 3000): el navegador ve un solo origen y la cookie de sesión funciona.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
