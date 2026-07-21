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
  console.log("[chatwoot] searchRes:", JSON.stringify(searchRes).slice(0, 300));
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
  console.log("[chatwoot] created:", JSON.stringify(created).slice(0, 300));
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

async function mirrorTextMessage(convId: string, text: string, outgoing = false): Promise<void> {
  await chatwootFetch(`/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: text,
      message_type: outgoing ? "outgoing" : "incoming",
      private: false,
    }),
  });
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

async function isConversationPaused(convId: string): Promise<boolean> {
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
