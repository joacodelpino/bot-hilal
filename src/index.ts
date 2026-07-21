import { handleVerification, parseIncomingMessages } from "./whatsapp/webhook.ts";
import { mirrorAndCheckStatus, mirrorBotReply, isConversationPaused } from "./chatwoot/chatwoot.ts";
import { sendTextMessage } from "./whatsapp/sender.ts";
import { processMessage } from "./bot.ts";

const PORT = parseInt(process.env.BOT_PORT ?? "3001");

// ── Cola en memoria por teléfono — serializa mensajes del mismo cliente ─────
const phoneQueues = new Map<string, Promise<void>>();

function enqueue(telefono: string, fn: () => Promise<void>): void {
  const prev = phoneQueues.get(telefono) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  phoneQueues.set(telefono, next);
  next.finally(() => {
    if (phoneQueues.get(telefono) === next) {
      phoneQueues.delete(telefono);
    }
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Webhook Meta WhatsApp ────────────────────────────────────────────────
    if (url.pathname === "/webhook") {
      if (req.method === "GET") {
        return handleVerification(req);
      }

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        // Meta espera 200 inmediato — procesamos en background, serializado por teléfono
        const messages = parseIncomingMessages(body);

        for (const msg of messages) {
          enqueue(msg.from, async () => {
            try {
              let bot_paused = false;
              let conv_id: string | undefined;
              try {
                ({ bot_paused, conv_id } = await mirrorAndCheckStatus(msg, msg.from));
              } catch (err) {
                console.error("[chatwoot] Error espejando mensaje (continuando):", err);
              }

              if (bot_paused) return;

              // Multimedia no soportada — responder y continuar
              if (msg.type !== "text" || !msg.text) {
                const mediaReply =
                  msg.type === "audio"
                    ? "Todavía no puedo escuchar audios. ¿Podés escribirme en texto lo que necesitás?"
                    : "No puedo procesar ese tipo de mensaje (imágenes, ubicaciones, etc.). ¿Podés describirlo en texto?";
                await sendTextMessage(msg.from, mediaReply);
                return;
              }

              const reply = await processMessage(msg.from, msg.text);
              if (reply) {
                // Revalidar bot_paused antes de enviar: un agente pudo
                // asignarse la conversación mientras OpenAI procesaba
                if (conv_id) {
                  try {
                    if (await isConversationPaused(conv_id)) return;
                  } catch {}
                }
                await sendTextMessage(msg.from, reply);
                if (conv_id) {
                  try {
                    await mirrorBotReply(conv_id, reply);
                  } catch (err) {
                    console.error("[chatwoot] Error espejando reply (continuando):", err);
                  }
                }
              }
            } catch (err) {
              console.error("[webhook] Error procesando mensaje:", err);
            }
          });
        }

        return new Response("OK", { status: 200 });
      }
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", ts: new Date().toISOString() });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Bot Hilal escuchando en puerto ${PORT}`);
