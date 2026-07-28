import type { IncomingMessage } from "../types.ts";

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN!;

// ─── Verificación del webhook (GET de Meta) ───────────────────────────────────

export function handleVerification(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ─── Parser del payload entrante (POST de Meta) ───────────────────────────────

/**
 * Extrae los mensajes relevantes del payload de Meta.
 * Ignora status updates (delivered, read, etc.).
 */
export function parseIncomingMessages(body: unknown): IncomingMessage[] {
  const payload = body as any;
  const messages: IncomingMessage[] = [];

  const entries = payload?.entry ?? [];
  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;
      const value = change?.value ?? {};
      const rawMessages = value?.messages ?? [];

      for (const msg of rawMessages) {
        // Ignorar status updates que llegan como mensajes
        if (!msg?.from || !msg?.id || !msg?.type) continue;

        const base: IncomingMessage = {
          from: msg.from,
          messageId: msg.id,
          type: msg.type,
          timestamp: msg.timestamp,
        };

        if (msg.type === "text") {
          base.text = msg.text?.body;
        } else if (["audio", "image", "document"].includes(msg.type)) {
          base.mediaId = msg[msg.type]?.id;
          base.caption = msg[msg.type]?.caption;
        }

        messages.push(base);
      }
    }
  }

  return messages;
}
