const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID!;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN!;
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

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
