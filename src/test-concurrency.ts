/**
 * Test de concurrencia — dispara N mensajes simultáneos al webhook para el
 * mismo teléfono y verifica que el carrito final tenga todos los items.
 *
 * Requiere: bot corriendo (local o remoto) + DB accesible via DATABASE_URL.
 *
 * Correr: BOT_URL=https://bot.hilalolivas.com.ar bun run src/test-concurrency.ts
 *   (o sin BOT_URL para http://localhost:3001)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOT_URL = process.env.BOT_URL ?? "http://localhost:3001";
const TEST_PHONE = "5491100000001"; // teléfono ficticio para tests

// ─── Helpers ────────────────────────────────────────────────────────────────

function metaPayload(from: string, text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "test",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "test" },
              messages: [
                {
                  from,
                  id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  type: "text",
                  text: { body: text },
                  timestamp: String(Math.floor(Date.now() / 1000)),
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

async function sendWebhook(text: string): Promise<void> {
  const res = await fetch(`${BOT_URL}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metaPayload(TEST_PHONE, text)),
  });
  if (!res.ok) throw new Error(`Webhook respondió ${res.status}`);
}

async function waitForProcessing(expectedItems: number, maxWaitMs = 30000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const row = await prisma.pedidos_en_curso.findUnique({
      where: { telefono_cliente: TEST_PHONE },
    });
    const items = (row?.items as any[]) ?? [];
    if (items.length >= expectedItems) return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Devolver lo que haya al timeout
  return prisma.pedidos_en_curso.findUnique({
    where: { telefono_cliente: TEST_PHONE },
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

async function setup() {
  // Limpiar o crear sesión vacía con nombre (para que el bot no pida nombre)
  await prisma.pedidos_en_curso.upsert({
    where: { telefono_cliente: TEST_PHONE },
    create: {
      telefono_cliente: TEST_PHONE,
      estado: "iniciado",
      items: [],
      nombre: "Test",
      apellido: "Concurrencia",
    },
    update: {
      estado: "iniciado",
      items: [],
      nombre: "Test",
      apellido: "Concurrencia",
      direccion: null,
      horario: null,
      notas: null,
    },
  });
}

// ─── Test ───────────────────────────────────────────────────────────────────

async function testConcurrency() {
  console.log(`\n=== Test de concurrencia — ${BOT_URL} ===\n`);

  await setup();
  console.log("  Setup: sesión limpia creada\n");

  // Disparar 3 mensajes simultáneos, cada uno debería agregar un producto distinto
  const messages = [
    "quiero 1 aceite de oliva de 500ml en vidrio",
    "quiero 2 aceitunas verdes 0 de 500g",
    "quiero 1 AOVE de 250ml",
  ];

  console.log("  Disparando 3 mensajes simultáneos...");
  await Promise.all(messages.map((m) => sendWebhook(m)));
  console.log("  Webhooks enviados, esperando procesamiento...\n");

  // Esperar a que los 3 items aparezcan (con timeout)
  const row = await waitForProcessing(3);
  const items = (row?.items as any[]) ?? [];

  console.log(`  Items en carrito: ${items.length}`);
  for (const item of items) {
    console.log(`    - product_id=${item.product_id} cantidad=${item.cantidad} variantes=${JSON.stringify(item.variantes)}`);
  }
  console.log();

  if (items.length === 3) {
    console.log("  ✓ PASS  Los 3 items están en el carrito (sin pisarse)");
  } else if (items.length < 3) {
    console.log(`  ✗ FAIL  Solo ${items.length}/3 items — la cola no serializó correctamente`);
    console.log("         Un write pisó a otro (condición de carrera)");
  } else {
    console.log(`  ⚠ WARN  ${items.length} items (más de 3) — el modelo interpretó algún mensaje como múltiples items`);
  }

  // Cleanup
  await prisma.pedidos_en_curso.update({
    where: { telefono_cliente: TEST_PHONE },
    data: { estado: "iniciado", items: [], direccion: null, horario: null, notas: null },
  });
  console.log("\n  Cleanup: sesión reseteada\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  await testConcurrency();
} catch (err) {
  console.error("Error en test de concurrencia:", err);
} finally {
  await prisma.$disconnect();
}
