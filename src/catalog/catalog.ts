import { readFileSync } from "fs";
import { join } from "path";
import type { CatalogProduct } from "../types.ts";

// ─── CSV parser (soporta campos entre comillas con comas internas) ─────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ─── Carga ────────────────────────────────────────────────────────────────────

function loadCatalog(): CatalogProduct[] {
  const csvPath = join(import.meta.dir, "../../data/catalog.csv");
  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const [_header, ...rows] = lines;

  return rows.map((line) => {
    const [product_id, product_name, variant_options_raw, requires_spec, category, aliases_raw] =
      parseCSVLine(line);

    const specNorm = requires_spec.trim().toUpperCase();
    if (specNorm !== "TRUE" && specNorm !== "FALSE") {
      throw new Error(
        `catalog.csv: valor inválido en requires_specification para product_id=${product_id}: "${requires_spec}". Solo se acepta TRUE o FALSE.`
      );
    }

    return {
      product_id,
      product_name,
      variant_options: variant_options_raw
        ? variant_options_raw.split(",").map((v) => v.trim()).filter(Boolean)
        : [],
      requires_specification: specNorm === "TRUE",
      category,
      aliases: aliases_raw
        ? aliases_raw.split(",").map((a) => a.trim()).filter(Boolean)
        : [],
    };
  });
}

// Singleton cargado una sola vez al arrancar
const catalog: CatalogProduct[] = loadCatalog();

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getProduct(productId: string): CatalogProduct | null {
  return catalog.find((p) => p.product_id === productId) ?? null;
}

export function getProductsByCategory(category: string): CatalogProduct[] {
  return catalog.filter(
    (p) => p.category.toLowerCase() === category.toLowerCase()
  );
}

export function getCategories(): string[] {
  return [...new Set(catalog.map((p) => p.category))];
}

/** Busca productos por coincidencia en nombre o alias (case-insensitive). */
export function searchProducts(query: string): CatalogProduct[] {
  const q = query.toLowerCase();
  return catalog.filter(
    (p) =>
      p.product_name.toLowerCase().includes(q) ||
      p.aliases.some((a) => a.toLowerCase().includes(q))
  );
}

/**
 * Valida que las variantes provistas sean válidas para el producto.
 * Si requires_specification=true y no hay valor, devuelve el error.
 */
export function validateVariants(
  product: CatalogProduct,
  variantes: Record<string, string>
): { valid: true } | { valid: false; missing: string } {
  if (!product.requires_specification) return { valid: true };

  const value = Object.values(variantes)[0]; // único eje de variante por ahora: tamaño
  if (!value) {
    return {
      valid: false,
      missing: `Falta el tamaño. Opciones disponibles: ${product.variant_options.join(", ")}`,
    };
  }

  if (!product.variant_options.includes(value)) {
    return {
      valid: false,
      missing: `"${value}" no es una opción válida. Opciones disponibles: ${product.variant_options.join(", ")}`,
    };
  }

  return { valid: true };
}

/** Retorna el catálogo completo (para el system prompt). */
export function getAllProducts(): CatalogProduct[] {
  return catalog;
}
