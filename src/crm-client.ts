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
      "X-API-Key": CRM_API_KEY,
    },
    body: JSON.stringify(order),
  });

  if (res.status === 401) {
    console.error(
      `[CRM AUTH ERROR] El CRM rechazó la request con 401 Unauthorized. ` +
      `Verificar que CRM_API_KEY coincida con ORDERS_WEBHOOK_API_KEY en el CRM. ` +
      `Pedido del teléfono ${order.telefono_cliente} NO fue registrado en el CRM.`
    );
    throw new Error(
      `CRM autenticación fallida (401): la API key del bot no coincide con la del CRM`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CRM respondió ${res.status}: ${body}`);
  }
}
