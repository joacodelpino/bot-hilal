import {
  addItem,
  removeItem,
  updateQuantity,
  replaceItem,
  updateSession,
  getOrCreateSession,
  clearSession,
} from "../session/session.ts";
import { getContact, upsertContact } from "../session/contacts.ts";
import { sendOrderToCRM, confirmedOrderSchema, type CRMOrderPayload } from "../crm-client.ts";
import { getProduct, validateVariants } from "../catalog/catalog.ts";
import { prisma } from "../db.ts";
import type { CartItem, Session } from "../types.ts";
import { randomUUID } from "crypto";

type ToolResult = { ok: true; session: Session; message: string } | { ok: false; error: string };

// ─── Formateador de carrito ───────────────────────────────────────────────────

export function formatCart(session: Session): string {
  if (session.items.length === 0) return "El pedido está vacío.";

  const lines = session.items.map((item, i) => {
    const product = getProduct(item.product_id);
    const name = product?.product_name ?? `product_id=${item.product_id}`;
    const varStr = Object.values(item.variantes).join(" ");
    return `${i + 1}. ${name}${varStr ? ` ${varStr}` : ""} × ${item.cantidad} (line_id: ${item.line_id})`;
  });

  return lines.join("\n");
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleAddItem(
  telefono: string,
  args: { product_id: string; variantes: Record<string, string>; cantidad: number }
): Promise<ToolResult> {
  const product = getProduct(args.product_id);
  if (!product) {
    return { ok: false, error: `Producto con id "${args.product_id}" no encontrado en el catálogo.` };
  }

  const validation = validateVariants(product, args.variantes);
  if (!validation.valid) {
    return { ok: false, error: validation.missing };
  }

  const session = await addItem(telefono, args.product_id, args.variantes, args.cantidad);
  return {
    ok: true,
    session,
    message: `Agregado: ${product.product_name}. Pedido actualizado:\n${formatCart(session)}`,
  };
}

export async function handleRemoveItem(
  telefono: string,
  args: { line_id: string }
): Promise<ToolResult> {
  const session = await removeItem(telefono, args.line_id);
  return {
    ok: true,
    session,
    message: `Ítem eliminado. Pedido actualizado:\n${formatCart(session)}`,
  };
}

export async function handleUpdateQuantity(
  telefono: string,
  args: { line_id: string; nueva_cantidad: number }
): Promise<ToolResult> {
  if (args.nueva_cantidad < 1) {
    return { ok: false, error: "La cantidad mínima es 1. Para eliminar el ítem, usá remove_item." };
  }
  const session = await updateQuantity(telefono, args.line_id, args.nueva_cantidad);
  return {
    ok: true,
    session,
    message: `Cantidad actualizada a ${args.nueva_cantidad}. Pedido actualizado:\n${formatCart(session)}`,
  };
}

export async function handleReplaceItem(
  telefono: string,
  args: { line_id: string; product_id_nuevo: string; variantes: Record<string, string> }
): Promise<ToolResult> {
  const product = getProduct(args.product_id_nuevo);
  if (!product) {
    return { ok: false, error: `Producto con id "${args.product_id_nuevo}" no encontrado en el catálogo.` };
  }

  const validation = validateVariants(product, args.variantes);
  if (!validation.valid) {
    return { ok: false, error: validation.missing };
  }

  const session = await replaceItem(telefono, args.line_id, args.product_id_nuevo, args.variantes);
  return {
    ok: true,
    session,
    message: `Ítem reemplazado por ${product.product_name}. Pedido actualizado:\n${formatCart(session)}`,
  };
}

export async function handleConfirmOrder(telefono: string): Promise<ToolResult> {
  const session = await getOrCreateSession(telefono);
  if (session.items.length === 0) {
    return { ok: false, error: "El pedido está vacío. Agregá productos antes de confirmar." };
  }

  const confirmedOrder = {
    telefono_cliente: telefono,
    nombre_apellido: [session.nombre, session.apellido].filter(Boolean).join(" ") || null,
    items: session.items,
    direccion: session.direccion,
    horario: session.horario,
    notas: session.notas,
    confirmed_at: new Date().toISOString(),
  };

  const validation = confirmedOrderSchema.safeParse(confirmedOrder);
  if (!validation.success) {
    console.error(
      `[CRM VALIDATION] Payload inválido para ${telefono}:`,
      JSON.stringify(validation.error.format(), null, 2)
    );
    return {
      ok: false,
      error: "Hubo un problema interno al procesar el pedido. Por favor intentá de nuevo o contactanos directamente.",
    };
  }

  // Enriquecer items con product_name del catálogo para que el CRM muestre nombres legibles
  const crmPayload: CRMOrderPayload = {
    ...confirmedOrder,
    items: confirmedOrder.items.map((item) => ({
      ...item,
      product_name: getProduct(item.product_id)?.product_name ?? item.product_id,
    })),
  };

  await sendOrderToCRM(crmPayload);

  // Transacción atómica: si algo falla aquí, el CRM ya recibió el pedido
  // pero la sesión local queda en "armando_pedido" → el log permite reconciliar a mano.
  try {
    await prisma.$transaction(async (tx) => {
      // recordConfirmedOrder: incrementa contador y guarda snapshot del último pedido
      const existing = await tx.contactos.findUnique({ where: { telefono } });
      const count = (existing?.cantidad_pedidos_confirmados ?? 0) + 1;
      await tx.contactos.upsert({
        where: { telefono },
        create: { telefono, cantidad_pedidos_confirmados: 1, ultimo_pedido_items: session.items as any },
        update: { cantidad_pedidos_confirmados: count, ultimo_pedido_items: session.items as any },
      });

      // updateSession: marca la sesión como confirmada y limpia el historial
      await tx.pedidos_en_curso.update({
        where: { telefono_cliente: telefono },
        data: { estado: "confirmado", historial: [] },
      });
    });
  } catch (err) {
    console.error(
      `[CONFIRM ORPHAN] CRM recibió el pedido de ${telefono} pero la transacción local falló. ` +
      `Reconciliar manualmente.\nDatos del pedido: ${JSON.stringify(confirmedOrder)}`,
      err
    );
    throw err;
  }

  return {
    ok: true,
    session: { ...session, estado: "confirmado" },
    message: "Pedido confirmado y enviado. ¡Gracias! Nos ponemos en contacto a la brevedad.",
  };
}

export async function handleCancelOrder(telefono: string): Promise<ToolResult> {
  await clearSession(telefono);
  const session = await getOrCreateSession(telefono);
  return {
    ok: true,
    session,
    message: "Pedido cancelado. Cuando quieras, podemos empezar de nuevo.",
  };
}

export async function handleShowCurrentOrder(telefono: string): Promise<ToolResult> {
  const session = await getOrCreateSession(telefono);
  return {
    ok: true,
    session,
    message: `Pedido actual:\n${formatCart(session)}`,
  };
}

export async function handleRepeatLastOrder(telefono: string): Promise<ToolResult> {
  const contact = await getContact(telefono);
  if (!contact?.ultimo_pedido_items?.length) {
    return { ok: false, error: "No hay pedido anterior registrado para este cliente." };
  }

  // Cargar el último pedido con nuevos line_ids para esta sesión
  const items: CartItem[] = contact.ultimo_pedido_items.map((item) => ({
    ...item,
    line_id: randomUUID(),
  }));

  const session = await updateSession(telefono, { items, estado: "armando_pedido", historial: [] });
  return {
    ok: true,
    session,
    message: `Cargué tu último pedido como punto de partida. Podés modificarlo o confirmarlo directamente:\n${formatCart(session)}`,
  };
}

export async function handleUpdateClientName(
  telefono: string,
  args: { nombre: string; apellido?: string }
): Promise<ToolResult> {
  const session = await updateSession(telefono, {
    nombre: args.nombre,
    ...(args.apellido && { apellido: args.apellido }),
  });

  // Persistir también en la tabla de contactos para no volver a preguntar
  const nombreCompleto = [args.nombre, args.apellido].filter(Boolean).join(" ");
  await upsertContact(telefono, nombreCompleto);

  return {
    ok: true,
    session,
    message: `Nombre registrado: ${nombreCompleto}. ¿En qué te puedo ayudar?`,
  };
}

export async function handleUpdateDeliveryInfo(
  telefono: string,
  args: { direccion?: string; horario?: string; notas?: string }
): Promise<ToolResult> {
  const session = await updateSession(telefono, {
    ...(args.direccion && { direccion: args.direccion }),
    ...(args.horario && { horario: args.horario }),
    ...(args.notas && { notas: args.notas }),
  });
  return {
    ok: true,
    session,
    message: "Datos de entrega actualizados.",
  };
}
