/**
 * Rate limiting en memoria con sliding window.
 * - Por teléfono: bloquea al cliente y le responde amablemente.
 * - Global: solo loggea warning (alerta de ataque, no corte de servicio).
 */

const LIMIT_PER_PHONE = parseInt(process.env.RATE_LIMIT_PER_PHONE ?? "20");
const LIMIT_GLOBAL = parseInt(process.env.RATE_LIMIT_GLOBAL ?? "200");
const WINDOW_MS = 60 * 1000; // 1 minuto

// Map<telefono, timestamps[]>
const phoneWindows = new Map<string, number[]>();
// timestamps globales
const globalWindow: number[] = [];

export type RateLimitResult =
  | { blocked: false }
  | { blocked: true; reason: "phone" | "global" };

export function checkRateLimit(telefono: string): RateLimitResult {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // ── Sliding window por teléfono ───────────────────────────────────────────
  const phoneTs = (phoneWindows.get(telefono) ?? []).filter((t) => t > cutoff);
  phoneTs.push(now);
  phoneWindows.set(telefono, phoneTs);

  if (phoneTs.length > LIMIT_PER_PHONE) {
    console.warn(
      `[rate-limit] Teléfono bloqueado: ${telefono} — ${phoneTs.length} msgs/min (límite ${LIMIT_PER_PHONE})`
    );
    return { blocked: true, reason: "phone" };
  }

  // ── Sliding window global ─────────────────────────────────────────────────
  // Limpiar in-place: eliminar los que quedaron fuera de la ventana
  let start = 0;
  while (start < globalWindow.length && globalWindow[start] <= cutoff) start++;
  if (start > 0) globalWindow.splice(0, start);
  globalWindow.push(now);

  if (globalWindow.length > LIMIT_GLOBAL) {
    console.warn(
      `[rate-limit] ALERTA GLOBAL: ${globalWindow.length} msgs/min (límite ${LIMIT_GLOBAL})`
    );
    // No bloquear — solo alertar
  }

  return { blocked: false };
}

// Limpiar phoneWindows periódicamente para no acumular teléfonos inactivos
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [phone, ts] of phoneWindows) {
    const fresh = ts.filter((t) => t > cutoff);
    if (fresh.length === 0) {
      phoneWindows.delete(phone);
    } else {
      phoneWindows.set(phone, fresh);
    }
  }
}, WINDOW_MS);
