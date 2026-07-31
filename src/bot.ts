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
  handleEscalateToHuman,
  handleShowCatalog,
  formatCart,
} from "./functions/handlers.ts";
import { getOrCreateSession, getSession, updateSession } from "./session/session.ts";
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

1. PRODUCTO Y VARIANTE — dos pasos obligatorios antes de llamar add_item:

   PASO 1 — ELEGIR PRODUCTO: Si el pedido del cliente puede corresponder a más de un
   product_id (ej: "aceitunas verdes en vidrio" aplica tanto al calibre 0 como al 00,
   que son productos distintos en el catálogo), preguntar el diferenciador antes de
   asignar el product_id. Nunca elegir un calibre o variedad por default.

   PASO 2 — CONFIRMAR TAMAÑO: Si el producto elegido tiene requires_specification=true,
   verificar que el cliente mencionó un valor de variant_options. Si no lo hizo,
   preguntar SOLO ese dato. Nunca asumir un default. Nunca inventar una variante.
   Palabras que describen envase pero NO son tamaño válido:
   bidón, bidoncito, envase, frasco, frasquito, botella, botellita, lata, latita, pote,
   potecito, tarro, tarrito, vasito — si el cliente usa una de estas palabras, pedirle
   el tamaño exacto (ej: 200g, 500g, 1kg).

   REGLA GENERAL: solo llamar add_item cuando el product_id sea inequívoco Y todas las
   variantes requeridas estén confirmadas por el cliente. Si falta cualquiera de los
   dos, preguntar antes de actuar.

   ERROR A NO REPETIR — secuencia correcta para "aceitunas verdes en vidrio":
   - El producto tiene calibre 0 (grande) y calibre 00 (gigante) como product_ids distintos,
     y ambos tienen variant_options: [200g, 500g, 1kg, 2kg] con requires_specification=true.
   - Turno 1 — cliente: "aceitunas verdes en vidrio" → bot pregunta calibre (PASO 1).
   - Turno 2 — cliente: "el calibre 0" → bot NO llama add_item todavía. Ahora que sabe
     el producto, aplica PASO 2: ese producto tiene requires_specification=true y el cliente
     aún no mencionó tamaño → bot pregunta tamaño: "¿Qué tamaño querés: 200g, 500g, 1kg o 2kg?"
   - Turno 3 — cliente: "500g" → recién ahora bot llama add_item con product_id=47, tamaño=500g.
   En ningún turno el bot debe asumir un tamaño por default.

2. CATÁLOGO: Nunca mostrar los 52 productos de golpe.
   - Si el cliente pregunta "¿qué tienen?" o "¿qué hay disponible?": llamar show_catalog
     sin category para listar las categorías.
   - Si el cliente pregunta por una categoría específica ("¿qué aceitunas tienen?"):
     llamar show_catalog con esa categoría.
   - Si el cliente ya sabe lo que quiere y lo pide directamente: NO llamar show_catalog,
     ir directo a resolver product_id y variantes (Regla 1).
   - Si el cliente dice algo genérico pero se puede acotar con una pregunta puntual
     (falta un solo dato), hacer esa pregunta antes de mostrar el catálogo.

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
   AMBIGÜEDAD: Si hay más de un ítem en el carrito que podría coincidir con lo que el
   cliente quiere modificar/eliminar, devolver una PREGUNTA EN TEXTO — sin llamar ninguna
   función. Describir brevemente cada opción para que el cliente pueda elegir.
   No llamar show_current_order para mostrar el carrito: el pedido ya está visible arriba.
   MÚLTIPLES ACCIONES: Si el mensaje contiene varias acciones (ej: "sacá X y agregá Y")
   y alguna de ellas es ambigua, resolver PRIMERO la ambigüedad preguntando en texto,
   sin ejecutar ninguna acción todavía — ni la ambigua ni las claras.

   ERROR A NO REPETIR: carrito tiene "Aceitunas verdes 0 × 2" y "Aceitunas verdes 00 × 1",
   cliente dice "sacame las aceitunas verdes" — hay DOS ítems que coinciden con esa
   descripción. El bot NO debe eliminar ninguno sin antes preguntar cuál: "¿Cuál querés
   sacar: las verdes calibre 0 (2 unidades) o las verdes calibre 00 (1 unidad)?"
   Solo llamar remove_item después de que el cliente identifique el ítem específico.

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
    pedido (ej: "el pedido anterior llegó mal", "me cobraron de más"), llamar
    escalate_to_human con el motivo correspondiente. No intentar resolver reclamos
    ni inventar soluciones.

11. ESCALACIÓN — llamar escalate_to_human en estos casos:
    - El cliente pide explícitamente hablar con una persona o un humano.
    - El cliente hace un reclamo o queja sobre un pedido anterior o entrega.
    - El cliente pregunta por precios, descuentos o condiciones comerciales
      (el bot tiene prohibido confirmarlos — Regla 8).
    - El cliente pregunta por fechas de entrega con insistencia o urgencia
      (el bot tiene prohibido estimarlas — Regla 9).
    - El bot no logra entender lo que el cliente necesita después de 2 intentos
      de aclaración sobre el mismo tema.
    El motivo debe describir brevemente la razón para que el agente tenga contexto.
    NO escalar por consultas normales del catálogo o del pedido en curso.

12. FORMATO: Las respuestas se envían por WhatsApp. NO usar markdown: nada de asteriscos (*),
    numerales (#), backticks (\`) ni ningún otro formato markdown. Escribir en texto plano.
    Para listas usar guiones simples (- item). Para énfasis, usar MAYÚSCULAS o simplemente
    escribir naturalmente.

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
    case "show_catalog": {
      const r = handleShowCatalog(args as any);
      return r.ok ? r.message : `Error: ${r.error}`;
    }
    case "escalate_to_human": {
      const r = await handleEscalateToHuman(telefono, args as any);
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
const MAX_HISTORY = 20; // máximo de mensajes en historial

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1")        // *italic* → italic
    .replace(/^#{1,6}\s+/gm, "")        // ## heading → heading
    .replace(/`([^`]+)`/g, "$1");       // `code` → code
}

/** Recorta historial a MAX_HISTORY y asegura que empiece con un mensaje de usuario */
function trimHistorial(msgs: any[]): any[] {
  let trimmed = msgs.slice(-MAX_HISTORY);
  while (trimmed.length > 0 && trimmed[0].role !== "user") {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

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

  // Cargar historial previo de la sesión
  const historial = (session.historial ?? []) as OpenAI.Chat.ChatCompletionMessageParam[];
  const historialLength = historial.length;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...historial,
    { role: "user", content: texto },
  ];

  // Loop de tool calling: el modelo puede llamar múltiples funciones en un turno
  let finalText = "";
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

    if (choice.finish_reason === "stop" || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
      finalText = choice.message.content ?? "";
      break;
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

  // Guardar historial: solo los mensajes nuevos de este turno, sobre lo que la DB tenga ahora
  // (los handlers de confirm/cancel/repeat ya limpiaron historial si correspondía)
  const newTurnMessages = messages.slice(1 + historialLength); // excluir system + historial viejo
  const freshSession = await getOrCreateSession(telefono);
  const baseHistorial = (freshSession.historial ?? []) as any[];
  const updatedHistorial = trimHistorial([...baseHistorial, ...newTurnMessages]);
  await updateSession(telefono, { historial: updatedHistorial });

  return stripMarkdown(finalText);
}
