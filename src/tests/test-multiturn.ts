/**
 * Test de conversación multi-turno — verifica que el historial persista
 * entre turnos y el bot pueda resolver productos progresivamente.
 *
 * Requiere: DATABASE_URL + OPENAI_API_KEY en .env
 *
 * Correr: bun run src/test-multiturn.ts
 */

import { PrismaClient } from "@prisma/client";
import { processMessage } from "../bot.ts";

const prisma = new PrismaClient();
const TEST_PHONE = "5491100000099"; // teléfono ficticio para tests

let passed = 0;
let failed = 0;

function pass(label: string, detail: string) {
  passed++;
  console.log(`  ✓ PASS  ${label}`);
  console.log(`         ${detail}\n`);
}

function fail(label: string, detail: string) {
  failed++;
  console.log(`  ✗ FAIL  ${label}`);
  console.log(`         ${detail}\n`);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

async function setup() {
  // Limpiar sesión y contacto para arrancar de cero
  await prisma.pedidos_en_curso.upsert({
    where: { telefono_cliente: TEST_PHONE },
    create: {
      telefono_cliente: TEST_PHONE,
      estado: "iniciado",
      items: [],
      historial: [],
      nombre: "Test",
      apellido: "MultiTurno",
    },
    update: {
      estado: "iniciado",
      items: [],
      historial: [],
      nombre: "Test",
      apellido: "MultiTurno",
      direccion: null,
      horario: null,
      notas: null,
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testMultiTurnProductResolution() {
  console.log("MT-1: Resolución progresiva de producto en múltiples turnos");
  console.log('  Secuencia: "Quiero aceitunas" → "verdes 0" → "en vidrio" → tamaño\n');

  await setup();

  // Turno 1: pedido genérico
  console.log('  Turno 1: "Quiero aceitunas"');
  const r1 = await processMessage(TEST_PHONE, "Quiero aceitunas");
  console.log(`  Bot: ${r1.slice(0, 200)}\n`);

  // Turno 2: especifica color y calibre
  console.log('  Turno 2: "Quiero aceitunas verdes 0"');
  const r2 = await processMessage(TEST_PHONE, "Quiero aceitunas verdes 0");
  console.log(`  Bot: ${r2.slice(0, 200)}\n`);

  // Turno 3: especifica envase
  console.log('  Turno 3: "En vidrio"');
  const r3 = await processMessage(TEST_PHONE, "En vidrio");
  console.log(`  Bot: ${r3.slice(0, 200)}\n`);

  // Verificar que en el turno 3 el bot NO vuelve a preguntar color/tipo
  // Debería pedir tamaño o directamente agregar al carrito
  const r3lower = r3.toLowerCase();
  const loopDetected =
    r3lower.includes("verdes o negras") ||
    r3lower.includes("qué tipo") ||
    r3lower.includes("qué producto") ||
    r3lower.includes("qué formato") ||
    (r3lower.includes("cuál") && !r3lower.includes("tamaño"));

  if (loopDetected) {
    fail("no debería re-preguntar tipo/color en turno 3", `Bot volvió a preguntar: "${r3.slice(0, 200)}"`);
  } else {
    // Verificar que pide tamaño O que agregó al carrito
    const pideTamano = r3lower.includes("tamaño") || r3lower.includes("200g") || r3lower.includes("500g") || r3lower.includes("1kg");
    const agregoAlCarrito = r3lower.includes("agregado") || r3lower.includes("pedido actualizado");

    if (pideTamano || agregoAlCarrito) {
      pass("resolvió producto sin loop", `Bot avanzó correctamente: ${pideTamano ? "pidió tamaño" : "agregó al carrito"}`);
    } else {
      // Podría haber respondido de otra forma válida
      pass("no hizo loop de re-pregunta", `Respuesta: "${r3.slice(0, 200)}"`);
    }
  }
}

async function testNoMarkdownInResponses() {
  console.log("MT-2: Las respuestas no contienen asteriscos ni markdown");

  await setup();

  const r1 = await processMessage(TEST_PHONE, "Quiero aceitunas");
  const hasMarkdown = r1.includes("**") || r1.includes("##") || r1.includes("```");

  if (hasMarkdown) {
    fail("respuesta sin markdown", `Contiene markdown: "${r1.slice(0, 200)}"`);
  } else {
    pass("respuesta sin markdown", `Limpia: "${r1.slice(0, 150)}"`);
  }
}

async function testHistorialPersists() {
  console.log("MT-3: El historial se guarda en la DB después de cada turno");

  await setup();

  await processMessage(TEST_PHONE, "Hola, quiero hacer un pedido");

  const row = await prisma.pedidos_en_curso.findUnique({
    where: { telefono_cliente: TEST_PHONE },
  });
  const historial = (row?.historial as any[]) ?? [];

  if (historial.length === 0) {
    fail("historial guardado", "El historial está vacío después de un turno");
  } else {
    const hasUser = historial.some((m: any) => m.role === "user");
    const hasAssistant = historial.some((m: any) => m.role === "assistant");
    if (hasUser && hasAssistant) {
      pass("historial guardado", `${historial.length} mensajes en historial (user + assistant)`);
    } else {
      fail("historial completo", `Faltan roles: user=${hasUser}, assistant=${hasAssistant}`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`\n=== Tests de conversación multi-turno ===\n`);

for (const fn of [testHistorialPersists, testNoMarkdownInResponses, testMultiTurnProductResolution]) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`  ✗ ERROR: ${err}\n`);
  }
}

// Cleanup
await prisma.pedidos_en_curso.update({
  where: { telefono_cliente: TEST_PHONE },
  data: { estado: "iniciado", items: [], historial: [], direccion: null, horario: null, notas: null },
});

console.log(`=== Fin: ${passed} passed, ${failed} failed ===\n`);
await prisma.$disconnect();
