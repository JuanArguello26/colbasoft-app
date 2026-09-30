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

/**
 * Política provisional de contraseñas: el SPEC la menciona (RF-ACC-006) pero no la define.
 * Se aplica un mínimo razonable hasta que el Director la fije.
 */
export function validarClaveNueva(clave: string, login: string): string | null {
  if (clave.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (clave.toLowerCase().includes(login.toLowerCase())) return "La contraseña no puede contener el nombre de usuario.";
  if (!/[A-Za-z]/.test(clave) || !/[0-9]/.test(clave)) return "La contraseña debe combinar letras y números.";
  return null;
}

/** Contraseña temporal aleatoria para usuarios nuevos: se muestra una sola vez y debe cambiarse en el primer acceso. */
export function claveTemporal(): string {
  const base = randomBytes(9).toString("base64url");
  return `${base}7a`; // garantiza letras y un número
}
