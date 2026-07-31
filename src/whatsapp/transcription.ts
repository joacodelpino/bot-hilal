import { openai } from "../openai.ts";
import { downloadMediaFromMeta } from "./sender.ts";
import { maskPhone } from "../utils/mask.ts";

const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";

// 25 MB — límite de la API de OpenAI
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type TranscriptionError =
  | "download_failed"
  | "transcription_failed"
  | "too_long"
  | "empty";

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; reason: TranscriptionError };

type Downloader = typeof downloadMediaFromMeta;
type Transcriber = (file: File) => Promise<string>;

interface TranscribeOptions {
  downloader?: Downloader;
  transcriber?: Transcriber;
}

/**
 * Descarga un audio de Meta y lo transcribe con OpenAI.
 * Acepta overrides opcionales de downloader/transcriber para tests.
 */
export async function transcribeAudio(
  mediaId: string,
  telefono: string,
  options: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  const download = options.downloader ?? downloadMediaFromMeta;
  const transcribe: Transcriber =
    options.transcriber ??
    ((file) =>
      openai.audio.transcriptions.create({
        model: TRANSCRIPTION_MODEL,
        file,
        language: "es",
        response_format: "text",
      }) as unknown as Promise<string>);

  // 1. Descargar el archivo de Meta
  let buffer: Buffer;
  let contentType: string;
  try {
    ({ buffer, contentType } = await download(mediaId));
  } catch (err) {
    console.error(
      `[transcription] Error descargando audio ${mediaId} para ${maskPhone(telefono)}:`,
      err
    );
    return { ok: false, reason: "download_failed" };
  }

  // 2. Verificar tamaño (> 25 MB es inusual en WhatsApp pero posible)
  if (buffer.length > MAX_AUDIO_BYTES) {
    console.warn(
      `[transcription] Audio demasiado grande (${buffer.length} bytes) para ${maskPhone(telefono)}`
    );
    return { ok: false, reason: "too_long" };
  }

  // 3. Determinar extensión a partir del content-type
  //    WhatsApp envía típicamente audio/ogg;codecs=opus — soportado por OpenAI
  const ext = contentType.includes("ogg")
    ? "ogg"
    : contentType.includes("mp4") || contentType.includes("mpeg")
    ? "mp4"
    : contentType.includes("webm")
    ? "webm"
    : contentType.includes("wav")
    ? "wav"
    : "ogg"; // fallback seguro para WhatsApp

  // 4. Transcribir
  let text: string;
  try {
    const file = new File([buffer], `audio.${ext}`, { type: contentType });
    text = (await transcribe(file)).trim();
  } catch (err) {
    console.error(
      `[transcription] Error transcribiendo audio para ${maskPhone(telefono)}:`,
      err
    );
    return { ok: false, reason: "transcription_failed" };
  }

  // 5. Verificar que la transcripción no esté vacía
  if (!text) {
    console.warn(`[transcription] Transcripción vacía para ${maskPhone(telefono)}`);
    return { ok: false, reason: "empty" };
  }

  return { ok: true, text };
}
