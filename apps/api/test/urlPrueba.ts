/** Las pruebas usan una base de datos propia (colbasoft_test) para no mezclarse con los datos de desarrollo. */
export function urlPrueba(): string {
  const base = process.env.DATABASE_URL ?? "postgresql://colbasoft:colbasoft@localhost:5433/colbasoft?schema=public";
  return base.replace(/\/colbasoft(\?|$)/, "/colbasoft_test$1");
}
