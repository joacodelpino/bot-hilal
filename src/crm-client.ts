import { z } from "zod";
import { maskPhone } from "./utils/mask.ts";

// ─── Tipo del payload que el CRM espera ──────────────────────────────────────

export interface CRMOrderPayload {
  telefono_cliente: string;
  nombre_apellido: string | null;
  items: Array<{
    product_id: string;
    product_name: string;
    variantes: Record<string, string>;
    cantidad: number;
  }>;
  direccion: string | null;
  horario: string | null;
  notas: string | null;
  confirmed_at: string;
}

const CRM_BASE_URL = process.env.CRM_BASE_URL!;
const CRM_API_KEY = process.env.CRM_API_KEY!;

// ─── Schema de validación ─────────────────────────────────────────────────────

const cartItemSchema = z.object({
  line_id: z.string().min(1),
  product_id: z.string().min(1),
  variantes: z.record(z.string()),
  cantidad: z.number().int().min(1),
}).strict();

export const confirmedOrderSchema = z.object({
  telefono_cliente: z.string().min(1),
  nombre_apellido: z.string().nullable(),
  items: z.array(cartItemSchema).min(1),
  direccion: z.string().nullable(),
  horario: z.string().nullable(),
  notas: z.string().nullable(),
  confirmed_at: z.string().datetime(),
}).strict(); // .strict() → cualquier campo extra (ej: precio) falla

// ─── Cliente CRM ──────────────────────────────────────────────────────────────

const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500];

/** Error distinguible para timeouts — el caller puede decidir si reintentar */
class CRMTimeoutError extends Error {
  constructor(telefono: string, attempt: number) {
    super(`CRM timeout (intento ${attempt}) para ${telefono}`);
    this.name = "CRMTimeoutError";
  }
}

/**
 * Ejecuta un fetch con timeout. Lanza CRMTimeoutError si se supera TIMEOUT_MS.
 */
async function fetchWithTimeout(url: string, opts: RequestInit, telefono: string, attempt: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new CRMTimeoutError(telefono, attempt);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof CRMTimeoutError || (err instanceof Error && err.message.startsWith("CRM 5xx"));
}

/**
 * Único punto de contacto con HilalSistema-V2.
 * El bot NUNCA escribe directo en la BD del CRM.
 */
export async function sendOrderToCRM(order: CRMOrderPayload): Promise<void> {
  const url = `${CRM_BASE_URL}/api/orders/incoming`;
  const opts: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": CRM_API_KEY,
    },
    body: JSON.stringify(order),
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts, order.telefono_cliente, attempt);

      // 401 — error de autenticación, sin reintentos
      if (res.status === 401) {
        console.error(
          `[CRM AUTH ERROR] El CRM rechazó la request con 401 Unauthorized. ` +
          `Verificar que CRM_API_KEY coincida con ORDERS_WEBHOOK_API_KEY en el CRM. ` +
          `Pedido del teléfono ${maskPhone(order.telefono_cliente)} NO fue registrado en el CRM.`
        );
        throw new Error(`CRM autenticación fallida (401): la API key del bot no coincide con la del CRM`);
      }

      // 400/422 — error de datos, sin reintentos
      if (res.status === 400 || res.status === 422) {
        const body = await res.text();
        console.error(
          `[CRM] Error de validación (${res.status}) para ${maskPhone(order.telefono_cliente)} — respuesta: ${body}`
        );
        throw new Error(`CRM rechazó el payload con ${res.status}: ${body}`);
      }

      // 5xx — transitorio, candidato a reintento
      if (res.status >= 500) {
        const body = await res.text();
        console.error(
          `[CRM] intento ${attempt}/${1 + MAX_RETRIES} — 5xx (${res.status}) para ${maskPhone(order.telefono_cliente)}: ${body}`
        );
        lastError = new Error(`CRM 5xx (${res.status}): ${body}`);
        // continúa al bloque de reintento
      } else if (!res.ok) {
        const body = await res.text();
        throw new Error(`CRM respondió ${res.status}: ${body}`);
      } else {
        return; // éxito
      }

    } catch (err) {
      if (err instanceof CRMTimeoutError) {
        console.error(
          `[CRM] intento ${attempt}/${1 + MAX_RETRIES} — TIMEOUT para ${maskPhone(order.telefono_cliente)}`
        );
        lastError = err;
      } else if (!isRetryable(err)) {
        throw err; // error definitivo (401, 400/422, etc.) — no reintentar
      } else {
        lastError = err;
      }
    }

    // Esperar antes del siguiente intento (si hay reintento disponible)
    if (attempt <= MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
  }

  throw new Error(
    `CRM no respondió correctamente tras ${1 + MAX_RETRIES} intentos para ${order.telefono_cliente}. ` +
    `Último error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
