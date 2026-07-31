const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID!;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN!;
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

const TYPING_DELAY_MIN_MS = parseInt(process.env.TYPING_DELAY_MIN_MS ?? "1000");
const TYPING_DELAY_MAX_MS = parseInt(process.env.TYPING_DELAY_MAX_MS ?? "4000");

export async function sendTextMessage(to: string, text: string): Promise<void> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta API respondió ${res.status}: ${body}`);
  }
}

/**
 * Muestra el indicador de "escribiendo..." en WhatsApp antes de enviar una respuesta.
 * Marca el mensaje recibido como leído (blue ticks) y activa el typing indicator.
 * Espera un delay proporcional a la longitud de la respuesta para simular escritura.
 * Fallo silencioso — es un efecto cosmético, no bloquea el envío del mensaje real.
 */
export async function showTypingIndicator(
  to: string,
  messageId: string,
  responseLength: number
): Promise<void> {
  // Calcular delay proporcional (interpolación lineal entre min y max)
  const ratio = Math.min(responseLength / 300, 1); // 0..1, satura en 300 chars
  const delayMs = Math.round(TYPING_DELAY_MIN_MS + ratio * (TYPING_DELAY_MAX_MS - TYPING_DELAY_MIN_MS));

  // Enviar typing indicator (también marca como leído automáticamente)
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Typing indicator → Meta ${res.status}: ${body}`);
  }

  // Esperar el delay antes de retornar para que el cliente vea el indicador
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Descarga un archivo multimedia de Meta por su media_id.
 * Retorna el buffer con el contenido y el content-type.
 */
export async function downloadMediaFromMeta(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  // Primero obtener la URL de descarga
  const metaRes = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`No se pudo obtener URL del media ${mediaId}`);
  const { url } = (await metaRes.json()) as { url: string };

  // Luego descargar el contenido
  const dlRes = await fetch(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!dlRes.ok) throw new Error(`No se pudo descargar el media ${mediaId}`);

  const contentType = dlRes.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  return { buffer, contentType };
}
