import { randomUUID } from "crypto";
import type { CartItem, Session, OrderStatus } from "../types.ts";
import { prisma } from "../db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSession(row: any): Session {
  return {
    telefono_cliente: row.telefono_cliente,
    estado: row.estado as OrderStatus,
    items: row.items as CartItem[],
    nombre: row.nombre,
    apellido: row.apellido,
    direccion: row.direccion,
    horario: row.horario,
    notas: row.notas,
    ultima_actualizacion: row.ultima_actualizacion,
  };
}

// ─── CRUD básico ──────────────────────────────────────────────────────────────

export async function getOrCreateSession(telefono: string): Promise<Session> {
  const row = await prisma.pedidos_en_curso.upsert({
    where: { telefono_cliente: telefono },
    create: { telefono_cliente: telefono, estado: "en_curso", items: [] },
    update: {},
  });
  return toSession(row);
}

export async function getSession(telefono: string): Promise<Session | null> {
  const row = await prisma.pedidos_en_curso.findUnique({
    where: { telefono_cliente: telefono },
  });
  return row ? toSession(row) : null;
}

export async function updateSession(
  telefono: string,
  update: Partial<Omit<Session, "telefono_cliente" | "ultima_actualizacion">>
): Promise<Session> {
  const row = await prisma.pedidos_en_curso.update({
    where: { telefono_cliente: telefono },
    data: update as any,
  });
  return toSession(row);
}

// ─── Operaciones de carrito ───────────────────────────────────────────────────

export async function addItem(
  telefono: string,
  product_id: string,
  variantes: Record<string, string>,
  cantidad: number
): Promise<Session> {
  const session = await getOrCreateSession(telefono);
  const newItem: CartItem = {
    line_id: randomUUID(),
    product_id,
    variantes,
    cantidad,
  };
  const items = [...session.items, newItem];
  return updateSession(telefono, { items, estado: "en_curso" });
}

export async function removeItem(
  telefono: string,
  line_id: string
): Promise<Session> {
  const session = await getOrCreateSession(telefono);
  const items = session.items.filter((i) => i.line_id !== line_id);
  return updateSession(telefono, { items });
}

/**
 * nueva_cantidad es el valor FINAL absoluto, no un delta.
 * Ej: si había 3 y el cliente dice "poneme 9", se llama con nueva_cantidad=9.
 */
export async function updateQuantity(
  telefono: string,
  line_id: string,
  nueva_cantidad: number
): Promise<Session> {
  const session = await getOrCreateSession(telefono);
  const items = session.items.map((i) =>
    i.line_id === line_id ? { ...i, cantidad: nueva_cantidad } : i
  );
  return updateSession(telefono, { items });
}

export async function replaceItem(
  telefono: string,
  line_id: string,
  product_id_nuevo: string,
  variantes: Record<string, string>
): Promise<Session> {
  const session = await getOrCreateSession(telefono);
  const items = session.items.map((i) =>
    i.line_id === line_id ? { ...i, product_id: product_id_nuevo, variantes } : i
  );
  return updateSession(telefono, { items });
}

export async function clearSession(telefono: string): Promise<void> {
  await prisma.pedidos_en_curso.update({
    where: { telefono_cliente: telefono },
    data: { items: [], estado: "en_curso", direccion: null, horario: null, notas: null },
  });
}
