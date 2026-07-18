import type { ConfirmedOrder } from "./types.ts";

const CRM_BASE_URL = process.env.CRM_BASE_URL!;
const CRM_API_KEY = process.env.CRM_API_KEY!;

/**
 * Único punto de contacto con HilalSistema-V2.
 * El bot NUNCA escribe directo en la BD del CRM.
 */
export async function sendOrderToCRM(order: ConfirmedOrder): Promise<void> {
  const res = await fetch(`${CRM_BASE_URL}/api/orders/incoming`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CRM_API_KEY}`,
    },
    body: JSON.stringify(order),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CRM respondió ${res.status}: ${body}`);
  }
}
