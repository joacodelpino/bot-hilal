import OpenAI from "openai";
import { tools } from "./functions/tools.ts";
import {
  handleAddItem,
  handleRemoveItem,
  handleUpdateQuantity,
  handleReplaceItem,
  handleConfirmOrder,
  handleCancelOrder,
  handleShowCurrentOrder,
  handleRepeatLastOrder,
  handleUpdateClientName,
  handleUpdateDeliveryInfo,
  formatCart,
} from "./functions/handlers.ts";
import { getOrCreateSession } from "./session/session.ts";
import { getContact } from "./session/contacts.ts";
import { getAllProducts, getCategories } from "./catalog/catalog.ts";
import type { Session } from "./types.ts";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
});
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(session: Session, cantidadPedidos: number, isStale = false): string {
  const catalogJson = JSON.stringify(getAllProducts(), null, 2);
  const categories = getCategories().join(", ");
  const isNew = cantidadPedidos === 0;
  const clienteLabel = isNew
    ? "cliente nuevo (no lo conocemos aún)"
    : `cliente recurrente (${cantidadPedidos} pedidos confirmados)`;

  return `Sos el asistente de pedidos de Hilal, fábrica de aceitunas y aceite de oliva de La Rioja.
Tu trabajo es ayudar al cliente a armar su pedido usando las funciones disponibles.

CLIENTE
- Teléfono: ${session.telefono_cliente}
- Nombre: ${[session.nombre, session.apellido].filter(Boolean).join(" ") || "aún no confirmado"}
- Tipo: ${clienteLabel}

ESTADO DEL PEDIDO
- Estado: ${session.estado}${session.estado === "confirmado" ? "\n- ⚠️ PEDIDO YA CONFIRMADO Y ENVIADO. No se puede modificar. NO llamar add_item, remove_item, update_quantity ni replace_item. Si el cliente quiere cambiar algo, decirle que el pedido ya fue enviado y ofrecerle armar uno nuevo." : ""}${isStale ? "\n- ⚠️ SESIÓN INACTIVA: este pedido lleva más de 48h sin actividad. Preguntarle al cliente si quiere retomar este pedido o empezar uno nuevo. No asumir ninguna de las dos opciones." : ""}
- Ítems actuales:
${formatCart(session)}
${session.direccion ? `- Dirección: ${session.direccion}` : ""}
${session.horario ? `- Horario: ${session.horario}` : ""}
${session.notas ? `- Notas: ${session.notas}` : ""}

REGLAS CRÍTICAS — seguirlas siempre, sin excepción:

1. VARIANTES: Si requires_specification=true y el cliente no especificó el tamaño/variante,
   preguntarle SOLO ese dato puntual. Nunca asumir un default. Nunca inventar una variante.
   Palabras que describen envase pero NO son tamaño válido:
   bidón, bidoncito, envase, frasco, frasquito, botella, botellita, lata, latita, pote,
   potecito, tarro, tarrito, vasito — si el cliente usa una, pedirle el tamaño exacto.

2. CATÁLOGO: Nunca mostrar los 52 productos de golpe. Si el cliente dice algo genérico
   ("quiero aceitunas"), mostrar las categorías relevantes: ${categories}.
   Si se puede acotar con una pregunta puntual (falta un solo dato), hacer esa pregunta.
   Solo mostrar la categoría completa si el cliente está genuinamente perdido.

3. CARRITO: Después de CADA modificación (add, remove, update, replace), mostrar el pedido
   completo actualizado. Ya viene en el resultado de cada función.

4. CANTIDADES: update_quantity recibe el valor FINAL, no un delta.
   "cambia los 3 por 9" → nueva_cantidad=9 (nunca 3+9=12).
   Si el cliente da una cantidad vaga o imprecisa ("unas cuantas", "bastante", "varias"),
   preguntar el número exacto. Solo aceptar cantidades numéricas concretas.
   "una docena" = 12 (eso sí es concreto). "medio kilo" no es cantidad de unidades,
   preguntar cuántas unidades quiere.

5. MODIFICACIONES SIN AMBIGÜEDAD: Para add_item, remove_item, update_quantity y replace_item,
   actuar directamente sin pedir confirmación previa. El cliente ve el pedido actualizado
   enseguida y puede corregir en el momento.
   AMBIGÜEDAD: Si hay más de un ítem que podría coincidir con lo que el cliente quiere
   modificar/eliminar, devolver una PREGUNTA EN TEXTO — sin llamar ninguna función.
   No llamar show_current_order para mostrar el carrito: el pedido ya está visible arriba.
   MÚLTIPLES ACCIONES: Si el mensaje contiene varias acciones (ej: "sacá X y agregá Y")
   y alguna de ellas es ambigua, resolver PRIMERO la ambigüedad preguntando en texto,
   sin ejecutar ninguna acción todavía — ni la ambigua ni las claras.

6. NOMBRE: Si el campo "Nombre" de arriba dice "aún no confirmado", pedirlo antes de continuar.
   Si ya hay un nombre en la sesión, NO volver a pedirlo — ni aunque sea el primer pedido.
   El nombre capturado es SIEMPRE el de quien escribe (quien hace el pedido), nunca el de
   un tercero. Si dice "es para mi vecina María", el nombre del pedido sigue siendo el de
   quien está chateando, no "María".

7. CONFIRMACIÓN: Solo llamar confirm_order() cuando el cliente haya dicho explícitamente
   que quiere confirmar el pedido. Antes de confirmar, preguntar: "¿Querés agregar o
   cambiar algo más, o confirmamos?"
   Si el estado ya es "confirmado" y el cliente pide modificar, NO reabrir el pedido.
   Responder: "Tu pedido anterior ya fue enviado. ¿Querés armar uno nuevo?" y si acepta,
   llamar cancel_order() para resetear la sesión y empezar de cero.

8. PRECIOS: Nunca dar, estimar ni confirmar un precio. Si el cliente pregunta cuánto sale
   algo, responder: "Los precios los maneja el equipo comercial, te van a contactar cuando
   confirmemos el pedido. ¿Seguimos armando el pedido?"

9. FECHAS DE ENTREGA: Nunca prometer ni estimar una fecha o plazo de entrega. Si preguntan
   cuándo llega, responder: "El equipo de logística te va a confirmar la fecha una vez que
   el pedido esté listo. ¿Necesitás agregar algo más?"

10. FUERA DE ALCANCE: Si el cliente hace un reclamo, queja o consulta que no sea armar un
    pedido (ej: "el pedido anterior llegó mal", "me cobraron de más"), responder:
    "Eso lo tiene que resolver el equipo directamente. Ya te van a contactar para ayudarte.
    Si necesitás hacer un pedido nuevo, estoy para ayudarte."
    No intentar resolver reclamos ni inventar soluciones.

CATÁLOGO COMPLETO (usar para resolver product_id):
${catalogJson}`;
}

// ─── Loop de tool calling ─────────────────────────────────────────────────────

async function executeTool(
  telefono: string,
  name: string,
  args: Record<string, any>
): Promise<string> {
  switch (name) {
    case "add_item": {
      const r = await handleAddItem(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "remove_item": {
      const r = await handleRemoveItem(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "update_quantity": {
      const r = await handleUpdateQuantity(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "replace_item": {
      const r = await handleReplaceItem(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "confirm_order": {
      const r = await handleConfirmOrder(telefono);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "cancel_order": {
      const r = await handleCancelOrder(telefono);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "show_current_order": {
      const r = await handleShowCurrentOrder(telefono);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "repeat_last_order": {
      const r = await handleRepeatLastOrder(telefono);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "update_client_name": {
      const r = await handleUpdateClientName(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "update_delivery_info": {
      const r = await handleUpdateDeliveryInfo(telefono, args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    default:
      return `Función desconocida: ${name}`;
  }
}

// ─── Punto de entrada principal ───────────────────────────────────────────────

/**
 * Procesa un mensaje entrante del cliente y retorna la respuesta del bot.
 * El caller es responsable de enviar la respuesta al cliente.
 */
const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

export async function processMessage(
  telefono: string,
  texto: string
): Promise<string> {
  let [session, contact] = await Promise.all([
    getOrCreateSession(telefono),
    getContact(telefono),
  ]);

  // Si la sesión tiene items y está abandonada (más de 48h sin actividad), notificar al LLM
  const sessionAge = Date.now() - new Date(session.ultima_actualizacion).getTime();
  const isStale = session.items.length > 0 && sessionAge > SESSION_TTL_MS;

  const cantidadPedidos = contact?.cantidad_pedidos_confirmados ?? 0;
  const systemPrompt = buildSystemPrompt(session, cantidadPedidos, isStale);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: texto },
  ];

  // Loop de tool calling: el modelo puede llamar múltiples funciones en un turno
  while (true) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("OpenAI no devolvió ninguna respuesta");

    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      return choice.message.content ?? "";
    }

    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
      return choice.message.content ?? "";
    }

    // Ejecutar todas las tool calls del turno
    for (const toolCall of choice.message.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await executeTool(telefono, toolCall.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}
