import { handleVerification, parseIncomingMessages } from "./whatsapp/webhook.ts";
import { mirrorAndCheckStatus, mirrorBotReply, isConversationPaused, handleChatwootOutbound, detectConversationResolved } from "./chatwoot/chatwoot.ts";
import { sendTextMessage } from "./whatsapp/sender.ts";
import { transcribeAudio } from "./whatsapp/transcription.ts";
import { processMessage } from "./bot.ts";
import { getSession, updateSession } from "./session/session.ts";

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

              // Chequeo local: si la sesión está escalada, el bot no responde.
              // El espejado ya ocurrió arriba, así que el agente humano ve el mensaje.
              // TODO: implementar auto-resolve como red de seguridad para conversaciones
              // que queden en estado "escalado" sin que el empleado marque Resolved.
              // Opción recomendada: Automation Rules de Chatwoot ("si etiqueta=escalado
              // y sin actividad > Xh, auto-resolver"). Ver: Chatwoot → Settings → Automation.
              try {
                const session = await getSession(msg.from);
                if (session?.estado === "escalado") return;
              } catch {
                // Si falla el chequeo de sesión, continuar con flujo normal
              }

              // Resolver el texto a procesar según el tipo de mensaje
              let textoParaProcesar: string | null = null;

              if (msg.type === "text" && msg.text) {
                textoParaProcesar = msg.text;
              } else if (msg.type === "audio" && msg.mediaId) {
                const tr = await transcribeAudio(msg.mediaId, msg.from);
                if (!tr.ok) {
                  const audioError =
                    tr.reason === "too_long"
                      ? "El audio es muy largo, ¿podés resumirlo en un mensaje más corto o escribirlo?"
                      : tr.reason === "empty"
                      ? "No pude entender el audio, ¿podés repetirlo o escribirlo?"
                      : "No pude escuchar tu mensaje de voz, ¿podés escribirlo o intentar de nuevo?";
                  await sendTextMessage(msg.from, audioError);
                  return;
                }
                textoParaProcesar = tr.text;
              } else {
                await sendTextMessage(
                  msg.from,
                  "No puedo procesar ese tipo de mensaje (imágenes, ubicaciones, etc.). ¿Podés describirlo en texto?"
                );
                return;
              }

              const reply = await processMessage(msg.from, textoParaProcesar);
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

    // ── Webhook Chatwoot outbound (agente humano → WhatsApp) ────────────────
    if (url.pathname === "/webhooks/chatwoot-outbound" && req.method === "POST") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const { shouldForward, phone, content } = handleChatwootOutbound(payload);

      if (shouldForward && phone && content) {
        console.log(`[chatwoot-outbound] Reenviando mensaje de agente a ${phone}`);
        // No encolamos — el agente humano tiene prioridad, no depende del bot
        try {
          await sendTextMessage(phone, content);
        } catch (err) {
          console.error("[chatwoot-outbound] Error enviando a WhatsApp:", err);
        }
      }

      // Detectar conversación resuelta → el bot retoma el control
      const resolvedPhone = detectConversationResolved(payload);
      if (resolvedPhone) {
        try {
          const session = await getSession(resolvedPhone);
          if (session?.estado === "escalado") {
            const nuevoEstado = session.items.length > 0 ? "armando_pedido" : "iniciado";
            await updateSession(resolvedPhone, { estado: nuevoEstado });
            console.log(`[chatwoot] Conversación resuelta — bot retoma para ${resolvedPhone} (estado: ${nuevoEstado})`);
          }
        } catch (err) {
          console.error("[chatwoot] Error al procesar conversation resolved:", err);
        }
      }

      return new Response("OK", { status: 200 });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", ts: new Date().toISOString() });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Bot Hilal escuchando en puerto ${PORT}`);
