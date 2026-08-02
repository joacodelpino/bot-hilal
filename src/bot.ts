import { openai, MODEL } from "./openai.ts";
import { maskPhone } from "./utils/mask.ts";
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
import { getOrCreateSession } from "./session/session.ts";
import { getContact } from "./session/contacts.ts";
import { getAllProducts } from "./catalog/catalog.ts";
import type { Session } from "./types.ts";

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(session: Session, cantidadPedidos: number): string {
  const catalogJson = JSON.stringify(getAllProducts(), null, 2);
  const isNew = cantidadPedidos === 0;
  const clienteLabel = isNew
    ? "cliente nuevo"
    : `cliente recurrente (${cantidadPedidos} pedidos confirmados)`;

  return `Sos un extractor de intención para Hilal, fábrica de aceitunas y aceite de oliva de La Rioja, Argentina.

TAREA: Analizar el mensaje del cliente e identificar qué productos del catálogo pide, con qué cantidades y variantes. Usar las funciones disponibles para modificar el carrito sugerido.

REGLAS:
- Si un producto puede corresponder a más de un product_id (ej: "aceitunas verdes en vidrio" aplica a calibre 0 y calibre 00, que son product_ids distintos), reportar la ambigüedad y listar las opciones. No elegir uno por default.
- Los calibres (0, 00, 1) son PRODUCTOS DISTINTOS con product_ids separados, no variantes del mismo producto.
- Si un producto tiene requires_specification=true y falta el tamaño, reportar qué falta y listar las opciones disponibles (variant_options). No asumir un tamaño.
- Palabras de envase (bidón, frasco, botella, lata, etc.) NO son tamaños válidos. Si el cliente las menciona sin un tamaño concreto, reportar el tamaño como faltante.
- update_quantity recibe el valor FINAL, no un delta. "cambia los 3 por 9" → nueva_cantidad=9.
- Cantidades vagas ("unas cuantas", "bastante") → reportar como dato faltante.

CLIENTE: ${clienteLabel}
Nombre: ${[session.nombre, session.apellido].filter(Boolean).join(" ") || "no registrado"}

CARRITO ACTUAL:
${formatCart(session)}

CATÁLOGO (usar para resolver product_id):
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
 * Normaliza un string eliminando diacríticos para matching accent-insensitive.
 * "olvidáte" → "olvidate", "ignorá" → "ignora"
 */
function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const INJECTION_PATTERNS = [
  /ignor\w+.{0,25}(instrucciones|reglas|prompt|sistema)/,
  /olvid\w+.{0,25}(instrucciones|reglas)/,
  /act[ua]\w*\s+como/,
  /sos\s+un\s+(nuevo|otro|diferente)/,
  /system\s*(prompt|message)/,
  /your\s+new\s+instructions/,
  /new\s+role/,
  /forget\s+(your|all)/,
  /ignore\s+(your|all|previous)/,
];

function logIfSuspicious(texto: string, telefono: string): void {
  const normalized = stripAccents(texto).toLowerCase();
  const matched = INJECTION_PATTERNS.find((p) => p.test(normalized));
  if (matched) {
    console.warn(
      `[injection] Posible intento de prompt injection — telefono: ${maskPhone(telefono)} — patron: ${matched} — texto: "${texto.slice(0, 120)}"`
    );
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1")        // *italic* → italic
    .replace(/^#{1,6}\s+/gm, "")        // ## heading → heading
    .replace(/`([^`]+)`/g, "$1");       // `code` → code
}

/** Elimina cualquier "(line_id: <uuid>)" que haya filtrado al texto final. */
function cleanLineIds(text: string): string {
  return text.replace(/\s*\(line_id:\s*[a-f0-9-]{36}\)/gi, "");
}

/**
 * Analiza un mensaje del cliente y retorna el resultado del análisis.
 * V2: cada mensaje se analiza de forma independiente (sin historial).
 * El resultado va como nota privada en Chatwoot, nunca al cliente.
 */
export async function analyzeMessage(
  telefono: string,
  texto: string
): Promise<string> {
  const [session, contact] = await Promise.all([
    getOrCreateSession(telefono),
    getContact(telefono),
  ]);

  const cantidadPedidos = contact?.cantidad_pedidos_confirmados ?? 0;
  const systemPrompt = buildSystemPrompt(session, cantidadPedidos);

  // Detectar posibles intentos de prompt injection (solo loggea, nunca bloquea)
  logIfSuspicious(texto, telefono);

  // Delimitar el input del cliente para separarlo semánticamente de las instrucciones del sistema
  const textoDelimitado = `<mensaje_cliente>${texto}</mensaje_cliente>`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: textoDelimitado },
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

  return stripMarkdown(cleanLineIds(finalText));
}
