/**
 * Test de TTL de sesión — manipula ultima_actualizacion en la DB
 * y verifica el comportamiento del bot según la edad de la sesión.
 *
 * Requiere: DATABASE_URL + OPENAI_API_KEY en .env
 *
 * Correr: bun run src/test-ttl.ts
 */

import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { tools } from "../functions/tools.ts";
import { buildSystemPrompt } from "../bot.ts";
import type { Session, CartItem } from "../types.ts";

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(hoursAgo: number): Session {
  return {
    telefono_cliente: `test-ttl-${hoursAgo}`,
    estado: "armando_pedido",
    items: [
      {
        line_id: "ttl-test-line-001",
        product_id: "63",
        variantes: { tamaño: "500ml" },
        cantidad: 2,
      },
    ],
    nombre: "Test",
    apellido: "TTL",
    direccion: null,
    horario: null,
    notas: null,
    ultima_actualizacion: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
  };
}

type SingleTurnResult =
  | { type: "tool_calls"; calls: { name: string; args: Record<string, unknown> }[]; textContent: string | null }
  | { type: "text"; content: string };

async function singleTurn(session: Session, userMessage: string, isStale: boolean): Promise<SingleTurnResult> {
  const systemPrompt = buildSystemPrompt(session, 0, isStale);
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    tools,
    tool_choice: "auto",
  });

  const choice = response.choices[0];
  if (!choice) throw new Error("OpenAI no devolvió ninguna respuesta");

  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
    return {
      type: "tool_calls",
      calls: choice.message.tool_calls.map((tc) => ({
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      })),
      textContent: choice.message.content ?? null,
    };
  }

  return { type: "text", content: choice.message.content ?? "" };
}

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

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testFreshSession() {
  console.log('TTL-1: Sesión de 47h + "hola" → debe seguir normal, sin preguntar retomar');
  const session = makeSession(47);
  const isStale = false; // 47h < 48h TTL

  const result = await singleTurn(session, "hola", isStale);

  const texto = result.type === "text" ? result.content : (result.textContent ?? "");
  const t = texto.toLowerCase();

  const preguntaRetomar =
    t.includes("retomar") || t.includes("inactiv") || t.includes("48");
  if (preguntaRetomar) {
    fail("no preguntó retomar (47h < TTL)", `Preguntó innecesariamente: "${texto.slice(0, 150)}"`);
  } else {
    pass("continuó normal sin preguntar retomar", `Respuesta: "${texto.slice(0, 150)}"`);
  }
}

async function testStaleSession() {
  console.log('TTL-2: Sesión de 49h + "hola" → debe preguntar retomar o empezar de cero');
  const session = makeSession(49);
  const isStale = true; // 49h > 48h TTL

  const result = await singleTurn(session, "hola", isStale);

  if (result.type === "tool_calls") {
    fail("preguntó antes de actuar", `Llamó funciones sin preguntar: ${result.calls.map((c) => c.name).join(", ")}`);
  } else {
    const t = result.content.toLowerCase();
    const preguntaRetomar =
      t.includes("retomar") || t.includes("continuar") || t.includes("anterior") ||
      t.includes("pendiente") || t.includes("nuevo") || t.includes("empezar") ||
      t.includes("inactiv");
    if (preguntaRetomar) {
      pass("preguntó si retomar o empezar de cero", `Respuesta: "${result.content.slice(0, 200)}"`);
    } else {
      fail("preguntó si retomar o empezar de cero", `No preguntó: "${result.content.slice(0, 200)}"`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`\n=== Tests de TTL de sesión — modelo: ${MODEL} ===\n`);

for (const fn of [testFreshSession, testStaleSession]) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`  ✗ ERROR: ${err}\n`);
  }
}

console.log(`=== Fin: ${passed} passed, ${failed} failed ===\n`);
await prisma.$disconnect();
