import type { Contact, CartItem } from "../types.ts";
import { prisma } from "../db.ts";

function toContact(row: any): Contact {
  return {
    telefono: row.telefono,
    nombre_apellido: row.nombre_apellido,
    primera_vez: row.primera_vez,
    ultima_interaccion: row.ultima_interaccion,
    cantidad_pedidos_confirmados: row.cantidad_pedidos_confirmados,
    ultimo_pedido_items: row.ultimo_pedido_items as CartItem[] | null,
  };
}

export async function getContact(telefono: string): Promise<Contact | null> {
  const row = await prisma.contactos.findUnique({ where: { telefono } });
  return row ? toContact(row) : null;
}

export async function upsertContact(
  telefono: string,
  nombre_apellido: string
): Promise<Contact> {
  const row = await prisma.contactos.upsert({
    where: { telefono },
    create: { telefono, nombre_apellido },
    update: { nombre_apellido },
  });
  return toContact(row);
}

/** Llamar al confirmar un pedido. Incrementa el contador y guarda el snapshot. */
export async function recordConfirmedOrder(
  telefono: string,
  items: CartItem[]
): Promise<Contact> {
  const existing = await prisma.contactos.findUnique({ where: { telefono } });
  const count = (existing?.cantidad_pedidos_confirmados ?? 0) + 1;

  const row = await prisma.contactos.upsert({
    where: { telefono },
    create: {
      telefono,
      cantidad_pedidos_confirmados: 1,
      ultimo_pedido_items: items as any,
    },
    update: {
      cantidad_pedidos_confirmados: count,
      ultimo_pedido_items: items as any,
    },
  });
  return toContact(row);
}
