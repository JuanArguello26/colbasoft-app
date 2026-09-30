/**
 * Genera data/datos_ficticios.xlsx con datos aleatorios y verosímiles (DS-1, SPEC v1.5 §12.8).
 * Es determinista (semilla fija) para que todo el equipo vea los mismos datos.
 * No contiene precios, clientes ni proveedores (DC-03) ni nombra ninguna empresa (DC-01).
 */
import ExcelJS from "exceljs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOJAS } from "../src/datos/excel.js";

function generador(semilla: number) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const azar = generador(2026);
const elegir = <T,>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)]!;
const algunos = <T,>(xs: readonly T[], n: number): T[] => {
  const copia = [...xs];
  const out: T[] = [];
  while (out.length < n && copia.length) out.push(copia.splice(Math.floor(azar() * copia.length), 1)[0]!);
  return out;
};

const COLORES = ["Blanco", "Negro", "Azul", "Rojo", "Verde", "Gris", "Beige", "Crudo", "Mostaza", "Vinotinto"];
const TALLAS = ["S", "M", "L", "XL"];
const PRENDAS = ["Camiseta cuello redondo", "Camiseta polo", "Buzo con capota", "Pantalón jogger", "Pantalón clásico", "Short deportivo", "Chaqueta ligera", "Falda plisada", "Vestido casual", "Camisa manga larga"];
const TELAS = ["Jersey algodón", "Popelina", "Drill", "Lycra", "Franela", "Gabardina", "Lino", "Tela deportiva"];
const INSUMOS = ["Cierre metálico", "Botón de concha", "Hilo de poliéster", "Elástico plano"];

const libro = new ExcelJS.Workbook();
const hoja = (n: keyof typeof HOJAS) => {
  const h = libro.addWorksheet(n);
  h.addRow([...HOJAS[n]]);
  h.getRow(1).font = { bold: true };
  return h;
};

// Usuarios: los cinco roles oficiales. La clave inicial es ficticia y solo sirve en desarrollo.
const usuarios = hoja("usuarios");
for (const [login, nombre, rol] of [
  ["admin", "Persona Demo Administradora", "ADMINISTRADOR"],
  ["jefe", "Persona Demo Jefe de Bodega", "JEFE_BODEGA"],
  ["coordinador", "Persona Demo Coordinadora", "COORDINADOR_BODEGA"],
  ["auxiliar1", "Persona Demo Auxiliar 1", "AUXILIAR_BODEGA"],
  ["auxiliar2", "Persona Demo Auxiliar 2", "AUXILIAR_BODEGA"],
  ["auditor", "Persona Demo Auditora", "AUDITOR"],
] as const) usuarios.addRow([login, nombre, rol, "Demo2026!"]);

const categorias = hoja("categorias");
for (const c of ["Prendas", "Telas", "Insumos"]) categorias.addRow([c]);

const referencias = hoja("referencias");
PRENDAS.forEach((d, i) =>
  referencias.addRow([`PRE-${String(i + 1).padStart(3, "0")}`, d, "Prendas", "UNIDADES", algunos(TALLAS, 2 + Math.floor(azar() * 3)).join(","), algunos(COLORES, 2 + Math.floor(azar() * 3)).join(",")]),
);
TELAS.forEach((d, i) =>
  referencias.addRow([`TEL-${String(i + 1).padStart(3, "0")}`, d, "Telas", elegir(["METROS", "KILOGRAMOS"]), "UNICA", algunos(COLORES, 2 + Math.floor(azar() * 3)).join(",")]),
);
INSUMOS.forEach((d, i) =>
  referencias.addRow([`INS-${String(i + 1).padStart(3, "0")}`, d, "Insumos", "UNIDADES", "UNICA", algunos(COLORES, 1 + Math.floor(azar() * 2)).join(",")]),
);

const bodegas = hoja("bodegas");
bodegas.addRow(["B1", "Bodega Principal"]);

const zonas = hoja("zonas");
const ubicaciones = hoja("ubicaciones");
const ZONAS: Array<[string, string, string, number]> = [
  ["REC", "Recepción", "RECEPCION", 3],
  ["ALM-A", "Almacenamiento A", "ALMACENAMIENTO", 8],
  ["ALM-B", "Almacenamiento B", "ALMACENAMIENTO", 8],
  ["ALM-C", "Almacenamiento C (telas)", "ALMACENAMIENTO", 6],
  ["PRE", "Preparación de salida", "PREPARACION_SALIDA", 3],
  ["CUA", "Cuarentena", "CUARENTENA", 2],
];
for (const [codigo, nombre, tipo, n] of ZONAS) {
  zonas.addRow(["B1", codigo, nombre, tipo]);
  for (let i = 1; i <= n; i++) ubicaciones.addRow(["B1", codigo, `${codigo}-${String(i).padStart(2, "0")}`]);
}

const salida = resolve(process.argv[2] ?? "../../data/datos_ficticios.xlsx");
mkdirSync(dirname(salida), { recursive: true });
await libro.xlsx.writeFile(salida);
console.log("Excel de datos ficticios generado:", salida);
