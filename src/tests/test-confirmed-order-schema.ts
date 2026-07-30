/**
 * Tests unitarios para confirmedOrderSchema (validación Zod antes de enviar al CRM).
 * Correr con: bun run src/tests/test-confirmed-order-schema.ts
 */

import { confirmedOrderSchema } from "../crm-client.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const basePayload = {
  telefono_cliente: "5491112345678",
  nombre_apellido: "Juan Pérez",
  items: [
    {
      line_id: "abc-123",
      product_id: "aceite-500g",
      variantes: { tamaño: "500g" },
      cantidad: 2,
    },
  ],
  direccion: "Av. Corrientes 1234",
  horario: "12:00-14:00",
  notas: null,
  confirmed_at: new Date().toISOString(),
};

// ─── (a) Payload válido pasa ──────────────────────────────────────────────────

console.log("\n[a] Payload válido:");
{
  const result = confirmedOrderSchema.safeParse(basePayload);
  assert("payload completo y válido pasa", result.success);
}
{
  const result = confirmedOrderSchema.safeParse({
    ...basePayload,
    nombre_apellido: null,
    direccion: null,
    horario: null,
    notas: null,
  });
  assert("campos nullable en null pasan", result.success);
}

// ─── (b) Items vacío falla ────────────────────────────────────────────────────

console.log("\n[b] Items vacío:");
{
  const result = confirmedOrderSchema.safeParse({ ...basePayload, items: [] });
  assert("items: [] falla", !result.success);
}
{
  const result = confirmedOrderSchema.safeParse({ ...basePayload, items: undefined });
  assert("items: undefined falla", !result.success);
}
{
  const result = confirmedOrderSchema.safeParse({
    ...basePayload,
    items: [{ ...basePayload.items[0], cantidad: 0 }],
  });
  assert("cantidad: 0 en un item falla", !result.success);
}

// ─── (c) Campo precio/monto extra falla (strict) ──────────────────────────────

console.log("\n[c] Campos extra no permitidos:");
{
  const result = confirmedOrderSchema.safeParse({ ...basePayload, precio: 1500 });
  assert("campo 'precio' extra falla", !result.success);
}
{
  const result = confirmedOrderSchema.safeParse({ ...basePayload, monto_total: 3000 });
  assert("campo 'monto_total' extra falla", !result.success);
}
{
  const result = confirmedOrderSchema.safeParse({
    ...basePayload,
    items: [{ ...basePayload.items[0], precio_unitario: 750 }],
  });
  assert("campo 'precio_unitario' en item falla", !result.success);
}

// ─── Otros casos de borde ─────────────────────────────────────────────────────

console.log("\n[d] Otros casos:");
{
  const result = confirmedOrderSchema.safeParse({ ...basePayload, telefono_cliente: "" });
  assert("telefono_cliente vacío falla", !result.success);
}
{
  const result = confirmedOrderSchema.safeParse({
    ...basePayload,
    confirmed_at: "no-es-una-fecha",
  });
  assert("confirmed_at no ISO falla", !result.success);
}

// ─── Resumen ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Resultado: ${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exit(1);
