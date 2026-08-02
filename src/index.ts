import { handleVerification, parseIncomingMessages, verifyMetaSignature } from "./whatsapp/webhook.ts";
import { mirrorAndCheckStatus, handleChatwootOutbound, detectConversationResolved, postPrivateNote } from "./chatwoot/chatwoot.ts";
import { sendTextMessage } from "./whatsapp/sender.ts";
import { transcribeAudio } from "./whatsapp/transcription.ts";
import { analyzeMessage } from "./bot.ts";
import { getSession, updateSession } from "./session/session.ts";
import { checkRateLimit } from "./middleware/rateLimit.ts";
import { maskPhone } from "./utils/mask.ts";

if (!process.env.META_APP_SECRET) {
  console.error(
    "[FATAL] META_APP_SECRET no está seteada. " +
    "El bot no puede arrancar sin verificación de firma del webhook de Meta."
  );
  process.exit(1);
}

const PORT = parseInt(process.env.BOT_PORT ?? "3001");

// ── Cola en memoria por teléfono — serializa mensajes del mismo cliente ─────
const phoneQueues = new Map<string, Promise<void>>();

// ── Deduplicación por message_id — evita doble procesamiento por retries de Meta ─
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutos
const seenMessageIds = new Map<string, number>(); // messageId → expiresAt

function isDuplicate(messageId: string): boolean {
  const expiresAt = seenMessageIds.get(messageId);
  if (expiresAt !== undefined && Date.now() < expiresAt) return true;
  seenMessageIds.set(messageId, Date.now() + DEDUP_TTL_MS);
  return false;
}

// Limpiar entries expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, expiresAt] of seenMessageIds) {
    if (now >= expiresAt) seenMessageIds.delete(id);
  }
}, DEDUP_TTL_MS);

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
        // Leer raw body primero — el HMAC se calcula sobre los bytes exactos
        const rawBody = await req.arrayBuffer();
        const signature = req.headers.get("x-hub-signature-256");

        if (!verifyMetaSignature(rawBody, signature)) {
          // Chatwoot usa la misma URL del inbox para sus propias notificaciones
          // internas (message_created, conversation_status_changed, etc.) — esos
          // requests no llevan firma de Meta. Los detectamos por el campo "account"
          // y los procesamos como webhooks de Chatwoot outbound.
          let parsedPayload: unknown;
          try { parsedPayload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { /* ignorar */ }
          const isChatwoot = (parsedPayload as any)?.account?.id !== undefined;
          if (isChatwoot) {
            // message_created ya lo maneja /webhooks/chatwoot-outbound — no procesar acá
            // para evitar doble reenvío (botMessageIds se consume en el primer handler).
            // Solo procesar conversation_status_changed (resolve → bot retoma control).
            const resolvedPhone = detectConversationResolved(parsedPayload);
            if (resolvedPhone) {
              try {
                const session = await getSession(resolvedPhone);
                if (session?.estado === "escalado") {
                  const nuevoEstado = session.items.length > 0 ? "armando_pedido" : "iniciado";
                  await updateSession(resolvedPhone, { estado: nuevoEstado });
                  console.log(`[chatwoot] Conversación resuelta (inbox) — bot retoma para ${maskPhone(resolvedPhone)}`);
                }
              } catch { /* ignorar */ }
            }
            return new Response("OK", { status: 200 });
          }

          const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "unknown";
          console.warn(`[webhook] Firma inválida o ausente — IP: ${ip}`);
          return new Response("Unauthorized", { status: 401 });
        }

        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(rawBody));
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        // Meta espera 200 inmediato — procesamos en background, serializado por teléfono
        const messages = parseIncomingMessages(body);

        for (const msg of messages) {
          enqueue(msg.from, async () => {
            if (isDuplicate(msg.messageId)) {
              console.debug(`[dedup] Mensaje duplicado ignorado: ${msg.messageId}`);
              return;
            }
            try {
              let bot_paused = false;
              let conv_id: string | undefined;
              try {
                ({ bot_paused, conv_id } = await mirrorAndCheckStatus(msg, msg.from));
              } catch (err) {
                console.error("[chatwoot] Error espejando mensaje (continuando):", err);
              }

              if (bot_paused) return;

              // Rate limiting — mirror ya ocurrió, Chatwoot ve el mensaje
              const rl = checkRateLimit(msg.from);
              if (rl.blocked) {
                await sendTextMessage(
                  msg.from,
                  "Estás enviando muchos mensajes seguidos. Esperá un momento y volvé a intentar."
                );
                return;
              }

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
              let transcripcion: string | null = null;

              if (msg.type === "text" && msg.text) {
                textoParaProcesar = msg.text;
              } else if (msg.type === "audio" && msg.mediaId) {
                const tr = await transcribeAudio(msg.mediaId, msg.from);
                if (!tr.ok) {
                  if (tr.reason === "too_long") {
                    await sendTextMessage(
                      msg.from,
                      "El audio es muy largo, ¿podés resumirlo en un mensaje más corto o escribirlo?"
                    );
                  } else {
                    console.warn(`[audio] Transcripción fallida (${tr.reason}) — ${maskPhone(msg.from)}`);
                  }
                  return;
                }
                textoParaProcesar = tr.text;
                transcripcion = tr.text;
              } else {
                // V2: el agente ve el multimedia en Chatwoot y responde él
                return;
              }

              const reply = await analyzeMessage(msg.from, textoParaProcesar);
              if (reply && conv_id) {
                let nota = "─── Análisis del bot ───\n";
                if (transcripcion) {
                  nota += `Transcripción: "${transcripcion}"\n\n`;
                }
                nota += reply;
                await postPrivateNote(conv_id, nota);
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
        console.log(`[chatwoot-outbound] Reenviando mensaje de agente a ${maskPhone(phone)}`);
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
            console.log(`[chatwoot] Conversación resuelta — bot retoma para ${maskPhone(resolvedPhone)} (estado: ${nuevoEstado})`);
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

// ── Handlers de errores no capturados — evitan que un error mate el proceso ──
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Error no capturado — el proceso sigue:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Promesa rechazada sin handler:", reason);
});

console.log(`Bot Hilal escuchando en puerto ${PORT}`);
