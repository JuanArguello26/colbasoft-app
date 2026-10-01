import ExcelJS from "exceljs";
import { ROLES, TIPOS_OPERACION, UNIDADES_MEDIDA, type Rol, type TipoOperacion, type UnidadMedida } from "@colbasoft/shared";
import { prisma } from "../db.js";
import { hashClave } from "../seguridad.js";
import { HOJAS, type NombreHoja } from "./excel.js";

type Fila = Record<string, string>;

function leerHoja(libro: ExcelJS.Workbook, nombre: NombreHoja): Fila[] {
  const hoja = libro.getWorksheet(nombre);
  if (!hoja) throw new Error(`Falta la hoja «${nombre}» en el Excel.`);
  const columnas = HOJAS[nombre];
  const filas: Fila[] = [];
  hoja.eachRow((row, n) => {
    if (n === 1) return;
    const f: Fila = {};
    columnas.forEach((c, i) => (f[c] = String(row.getCell(i + 1).value ?? "").trim()));
    if (Object.values(f).some((v) => v !== "")) filas.push(f);
  });
  return filas;
}

export interface Resumen {
  usuarios: number;
  categorias: number;
  referencias: number;
  skus: number;
  zonas: number;
  ubicaciones: number;
  motivos: number;
}

/** Carga (o vuelve a cargar) los datos ficticios. Es idempotente: no duplica nada. */
export async function cargarExcel(ruta: string): Promise<Resumen> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.readFile(ruta);

  for (const u of leerHoja(libro, "usuarios")) {
    if (!ROLES.includes(u.rol as Rol)) throw new Error(`Rol desconocido: ${u.rol}`);
    const existente = await prisma.usuario.findUnique({ where: { login: u.login } });
    if (existente) await prisma.usuario.update({ where: { login: u.login }, data: { nombre: u.nombre, rol: u.rol as Rol } });
    else await prisma.usuario.create({ data: { login: u.login, nombre: u.nombre, rol: u.rol as Rol, passwordHash: hashClave(u.clave_inicial) } });
  }

  const categorias = leerHoja(libro, "categorias");
  for (const c of categorias) await prisma.categoria.upsert({ where: { nombre: c.nombre }, update: {}, create: { nombre: c.nombre } });

  let skus = 0;
  const refs = leerHoja(libro, "referencias");
  for (const r of refs) {
    if (!UNIDADES_MEDIDA.includes(r.unidad_medida as UnidadMedida)) throw new Error(`Unidad de medida desconocida: ${r.unidad_medida}`);
    const categoria = await prisma.categoria.findUniqueOrThrow({ where: { nombre: r.categoria } });
    const ref = await prisma.referencia.upsert({
      where: { codigo: r.codigo },
      update: { descripcion: r.descripcion },
      create: { codigo: r.codigo, descripcion: r.descripcion, categoriaId: categoria.id, unidadMedida: r.unidad_medida as UnidadMedida },
    });
    for (const t of r.tallas.split(",").map((x) => x.trim()).filter(Boolean)) {
      const talla = await prisma.talla.upsert({ where: { nombre: t }, update: {}, create: { nombre: t } });
      for (const c of r.colores.split(",").map((x) => x.trim()).filter(Boolean)) {
        const color = await prisma.color.upsert({ where: { nombre: c }, update: {}, create: { nombre: c } });
        await prisma.sku.upsert({
          where: { referenciaId_tallaId_colorId: { referenciaId: ref.id, tallaId: talla.id, colorId: color.id } },
          update: {},
          create: { referenciaId: ref.id, tallaId: talla.id, colorId: color.id },
        });
        skus++;
      }
    }
  }

  for (const b of leerHoja(libro, "bodegas")) await prisma.bodega.upsert({ where: { codigo: b.codigo }, update: { nombre: b.nombre }, create: { codigo: b.codigo, nombre: b.nombre } });

  const zonasHoja = leerHoja(libro, "zonas");
  for (const z of zonasHoja) {
    const bodega = await prisma.bodega.findUniqueOrThrow({ where: { codigo: z.bodega } });
    const zona = await prisma.zona.upsert({
      where: { bodegaId_codigo: { bodegaId: bodega.id, codigo: z.codigo } },
      update: { nombre: z.nombre },
      create: { bodegaId: bodega.id, codigo: z.codigo, nombre: z.nombre, tipo: z.tipo as never },
    });
    // La categoría de la zona solo se completa si está vacía: lo que el Administrador haya configurado no se pisa al volver a cargar.
    if (z.categoria) {
      const categoria = await prisma.categoria.findUniqueOrThrow({ where: { nombre: z.categoria } });
      await prisma.zona.updateMany({ where: { id: zona.id, categoriaId: null }, data: { categoriaId: categoria.id } });
    }
  }

  const ubicacionesHoja = leerHoja(libro, "ubicaciones");
  for (const u of ubicacionesHoja) {
    const bodega = await prisma.bodega.findUniqueOrThrow({ where: { codigo: u.bodega } });
    const zona = await prisma.zona.findUniqueOrThrow({ where: { bodegaId_codigo: { bodegaId: bodega.id, codigo: u.zona } } });
    await prisma.ubicacion.upsert({
      where: { bodegaId_codigo: { bodegaId: bodega.id, codigo: u.codigo } },
      update: {},
      create: { bodegaId: bodega.id, zonaId: zona.id, codigo: u.codigo },
    });
  }

  for (const m of leerHoja(libro, "motivos")) {
    if (!TIPOS_OPERACION.includes(m.tipo_operacion as TipoOperacion)) throw new Error(`Tipo de operación desconocido: ${m.tipo_operacion}`);
    const tipo = m.tipo_operacion as TipoOperacion;
    await prisma.motivo.upsert({
      where: { tipoOperacion_nombre: { tipoOperacion: tipo, nombre: m.nombre } },
      update: {},
      create: { tipoOperacion: tipo, nombre: m.nombre, exigeEvidencia: m.exige_evidencia.toUpperCase() === "SI" },
    });
  }

  return {
    motivos: await prisma.motivo.count(),
    usuarios: await prisma.usuario.count(),
    categorias: await prisma.categoria.count(),
    referencias: await prisma.referencia.count(),
    skus: await prisma.sku.count(),
    zonas: await prisma.zona.count(),
    ubicaciones: await prisma.ubicacion.count(),
  };
}
