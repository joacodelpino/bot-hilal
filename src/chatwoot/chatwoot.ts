import { downloadMediaFromMeta } from "../whatsapp/sender.ts";
import { getContact } from "../session/contacts.ts";
import type { ChatwootResult, IncomingMessage } from "../types.ts";

const BASE_URL = process.env.CHATWOOT_BASE_URL!;
const API_TOKEN = process.env.CHATWOOT_API_TOKEN!;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID ?? "1";
const INBOX_ID = process.env.CHATWOOT_INBOX_ID!;

function headers() {
  return {
    "Content-Type": "application/json",
    api_access_token: API_TOKEN,
  };
}

async function chatwootFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}${path}`, {
    ...opts,
    headers: { ...headers(), ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chatwoot ${opts.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(telefono: string): string {
  return telefono.replace(/\D/g, "");
}

async function findOrCreateContact(telefono: string, nombre?: string | null): Promise<string> {
  const phone = normalizePhone(telefono);

  // Buscar contacto existente
  const searchRes = await chatwootFetch(
    `/contacts/search?q=${phone}&include_contacts=true`
  );
  const contacts = Array.isArray(searchRes?.payload)
    ? searchRes.payload
    : (searchRes?.payload?.contacts ?? []);
  const existing = contacts.find(
    (c: any) => normalizePhone(c.phone_number ?? "") === phone
  );

  if (existing) {
    // Actualizar nombre si cambió
    if (nombre && existing.name !== nombre) {
      await chatwootFetch(`/contacts/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nombre }),
      });
    }
    return existing.id;
  }

  // Crear nuevo contacto
  const created = await chatwootFetch("/contacts", {
    method: "POST",
    body: JSON.stringify({ phone_number: `+${phone}`, name: nombre ?? phone }),
  });
  return (created.id ?? created?.payload?.id ?? created?.payload?.contact?.id) as string;
}

async function findOrCreateConversation(contactId: string): Promise<string> {
  const convRes = await chatwootFetch(`/contacts/${contactId}/conversations`);
  // Solo usar conversaciones abiertas que pertenezcan al inbox API
  const openConv = convRes?.payload?.find(
    (c: any) => c.status === "open" && String(c.inbox_id) === String(INBOX_ID)
  );
  if (openConv) return openConv.id;

  const newConv = await chatwootFetch("/conversations", {
    method: "POST",
    body: JSON.stringify({ contact_id: contactId, inbox_id: INBOX_ID }),
  });
  return newConv.id;
}

// IDs de mensajes creados por el bot — para ignorarlos en el webhook outbound
const botMessageIds = new Set<number>();

async function mirrorTextMessage(convId: string, text: string, outgoing = false): Promise<void> {
  const result = await chatwootFetch(`/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: text,
      message_type: outgoing ? "outgoing" : "incoming",
      private: false,
    }),
  });

  // Trackear mensajes outgoing del bot para no reenviarlos desde el webhook
  if (outgoing && result?.id) {
    botMessageIds.add(result.id);
    // Limitar tamaño del Set para evitar memory leak
    if (botMessageIds.size > 500) {
      const oldest = [...botMessageIds].slice(0, 250);
      oldest.forEach((id) => botMessageIds.delete(id));
    }
  }
}

async function mirrorMediaMessage(
  convId: string,
  msg: IncomingMessage
): Promise<void> {
  if (!msg.mediaId) return;
  const { buffer, contentType } = await downloadMediaFromMeta(msg.mediaId);

  const ext = contentType.split("/")[1] ?? "bin";
  const formData = new FormData();
  formData.append(
    "attachments[]",
    new Blob([buffer], { type: contentType }),
    `media.${ext}`
  );
  formData.append("message_type", "incoming");
  formData.append("private", "false");
  if (msg.caption) {
    formData.append("content", msg.caption);
  }

  // FormData requiere headers sin Content-Type (browser lo pone automático con boundary)
  await fetch(
    `${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: "POST",
      headers: { api_access_token: API_TOKEN },
      body: formData,
    }
  );
}

export async function isConversationPaused(convId: string): Promise<boolean> {
  const conv = await chatwootFetch(`/conversations/${convId}`);
  // "Pausado" = tiene un agente humano asignado (funcionalidad nativa de Chatwoot)
  return !!conv?.meta?.assignee;
}

async function updateContactAttributes(
  contactId: string,
  cantidadPedidos: number
): Promise<void> {
  const tipo = cantidadPedidos === 0 ? "nuevo" : "recurrente";
  await chatwootFetch(`/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({
      custom_attributes: {
        tipo_cliente: tipo,
        pedidos_confirmados: cantidadPedidos,
      },
    }),
  });
}

// ─── Webhook outbound: Chatwoot → WhatsApp ──────────────────────────────────

/**
 * Procesa un webhook `message_created` de Chatwoot.
 * Si el mensaje fue escrito por un agente humano (no por el bot),
 * lo reenvía al cliente por WhatsApp.
 * Retorna true si se reenvió, false si se ignoró.
 */
export function handleChatwootOutbound(payload: any): {
  shouldForward: boolean;
  phone: string | null;
  content: string | null;
} {
  // Solo procesar message_created
  if (payload.event !== "message_created") {
    return { shouldForward: false, phone: null, content: null };
  }

  // Solo procesar mensajes outgoing (respuestas al cliente)
  if (payload.message_type !== "outgoing") {
    return { shouldForward: false, phone: null, content: null };
  }

  // Ignorar mensajes privados (notas internas de Chatwoot)
  if (payload.private === true) {
    return { shouldForward: false, phone: null, content: null };
  }

  // FILTRO CLAVE: ignorar mensajes generados por el bot (trackeados por ID)
  const msgId = payload.id;
  if (msgId && botMessageIds.has(msgId)) {
    botMessageIds.delete(msgId);
    return { shouldForward: false, phone: null, content: null };
  }

  // Extraer teléfono del contacto de la conversación
  const phone = payload.conversation?.meta?.sender?.phone_number;
  if (!phone) {
    console.error("[chatwoot-outbound] No se encontró phone_number en el payload");
    return { shouldForward: false, phone: null, content: null };
  }

  // Normalizar teléfono: quitar el "+" inicial
  const normalizedPhone = phone.replace(/^\+/, "");

  const content = payload.content;
  if (!content) {
    return { shouldForward: false, phone: null, content: null };
  }

  return { shouldForward: true, phone: normalizedPhone, content };
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Espeja el mensaje a Chatwoot y devuelve si el bot debe pausarse.
 * Llamar en cada mensaje entrante, ANTES de procesar con el bot.
 */
export async function mirrorBotReply(convId: string, text: string): Promise<void> {
  await mirrorTextMessage(convId, text, true);
}

export async function mirrorAndCheckStatus(
  msg: IncomingMessage,
  telefono: string
): Promise<ChatwootResult> {
  const contact = await getContact(telefono);
  const nombre = contact?.nombre_apellido;
  const cantidadPedidos = contact?.cantidad_pedidos_confirmados ?? 0;

  const contactId = await findOrCreateContact(telefono, nombre);
  await updateContactAttributes(contactId, cantidadPedidos);

  const convId = await findOrCreateConversation(contactId);

  if (msg.type === "text" && msg.text) {
    await mirrorTextMessage(convId, msg.text);
  } else if (["audio", "image", "document"].includes(msg.type)) {
    await mirrorMediaMessage(convId, msg);
  }

  const bot_paused = await isConversationPaused(convId);
  return { bot_paused, conv_id: String(convId) };
}
