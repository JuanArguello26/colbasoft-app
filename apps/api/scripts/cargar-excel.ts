import { resolve } from "node:path";
import { cargarExcel } from "../src/datos/cargar-excel.js";
import { prisma } from "../src/db.js";

const ruta = resolve(process.argv[2] ?? "../../data/datos_ficticios.xlsx");
try {
  const r = await cargarExcel(ruta);
  console.log("Datos ficticios cargados desde", ruta);
  console.table(r);
} finally {
  await prisma.$disconnect();
}
