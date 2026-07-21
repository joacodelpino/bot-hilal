import { handleVerification, parseIncomingMessages } from "./whatsapp/webhook.ts";
import { mirrorAndCheckStatus } from "./chatwoot/chatwoot.ts";
import { sendTextMessage } from "./whatsapp/sender.ts";
import { processMessage } from "./bot.ts";

const PORT = parseInt(process.env.BOT_PORT ?? "3001");

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

        // Meta espera 200 inmediato — procesamos en background
        (async () => {
          try {
            const messages = parseIncomingMessages(body);

            for (const msg of messages) {
              // Solo procesamos texto por ahora (audio/imagen: solo espejar)
              const { bot_paused } = await mirrorAndCheckStatus(msg, msg.from);

              if (bot_paused) continue;
              if (msg.type !== "text" || !msg.text) continue;

              const reply = await processMessage(msg.from, msg.text);
              if (reply) {
                await sendTextMessage(msg.from, reply);
              }
            }
          } catch (err) {
            console.error("[webhook] Error procesando mensaje:", err);
          }
        })();

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
