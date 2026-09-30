import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash de contraseña con scrypt (incluido en Node; sin dependencias nativas). Formato: scrypt$sal$hash. */
export function hashClave(clave: string): string {
  const sal = randomBytes(16).toString("hex");
  const hash = scryptSync(clave, sal, 64).toString("hex");
  return `scrypt$${sal}$${hash}`;
}

export function verificarClave(clave: string, guardado: string): boolean {
  const [alg, sal, hash] = guardado.split("$");
  if (alg !== "scrypt" || !sal || !hash) return false;
  const calculado = scryptSync(clave, sal, 64);
  const esperado = Buffer.from(hash, "hex");
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}
