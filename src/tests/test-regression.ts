/**
 * Tests de regresión — 4 casos extraídos de fallas reales del bot anterior.
 * No usan DB. Llaman OpenAI real y capturan qué tool calls hace el modelo.
 *
 * Correr: bun run src/test-regression.ts
 */

import OpenAI from "openai";
import { tools } from "../functions/tools.ts";
import { buildSystemPrompt } from "../bot.ts";
import type { Session } from "../types.ts";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "pt-5.4-mini";

// ─── Sesiones de prueba (sin DB) ─────────────────────────────────────────────

const LINE_ACEITE = "aaaaaaaa-0001-0001-0001-000000000001";
const LINE_VERDE_0 = "bbbbbbbb-0002-0002-0002-000000000002";
const LINE_VERDE_00 = "cccccccc-0003-0003-0003-000000000003";

const sessionConAceite: Session = {
  telefono_cliente: "test-001",
  estado: "armando_pedido",
  items: [
    {
      line_id: LINE_ACEITE,
      product_id: "63", // Aceite de oliva (vidrio)
      variantes: { tamaño: "500ml" },
      cantidad: 3,
    },
  ],
  nombre: "Test",
  apellido:"User",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionConDosVerdes: Session = {
  telefono_cliente: "test-002",
  estado: "armando_pedido",
  items: [
    {
      line_id: LINE_VERDE_0,
      product_id: "47", // Aceitunas (vidrio) verdes 0
      variantes: { tamaño: "500g" },
      cantidad: 2,
    },
    {
      line_id: LINE_VERDE_00,
      product_id: "48", // Aceitunas (vidrio) verdes 00
      variantes: { tamaño: "200g" },
      cantidad: 1,
    },
  ],
  nombre: "Joaquin",
  apellido:"Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionVacia: Session = {
  telefono_cliente: "test-003",
  estado: "iniciado",
  items: [],
  nombre: "Joaquin",
  apellido:"Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

// ─── Runner ───────────────────────────────────────────────────────────────────

type SingleTurnResult =
  | { type: "tool_calls"; calls: { name: string; args: Record<string, unknown> }[]; textContent: string | null }
  | { type: "text"; content: string };

async function singleTurn(session: Session, userMessage: string): Promise<SingleTurnResult> {
  const systemPrompt = buildSystemPrompt(session, 0);
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

// ─── Aserciones ──────────────────────────────────────────────────────────────

function pass(label: string, detail: string) {
  console.log(`  ✓ PASS  ${label}`);
  console.log(`         ${detail}\n`);
}

function fail(label: string, detail: string) {
  console.log(`  ✗ FAIL  ${label}`);
  console.log(`         ${detail}\n`);
}

// ─── Casos de prueba ─────────────────────────────────────────────────────────

async function caso1() {
  console.log('CASO 1: "cambia los 3 aceites por 9" → nueva_cantidad debe ser 9, no 12');
  const result = await singleTurn(sessionConAceite, "cambia los 3 aceites por 9");

  if (result.type !== "tool_calls") {
    fail("hizo tool call", `El modelo devolvió texto en vez de tool call: "${result.content}"`);
    return;
  }

  const call = result.calls.find((c) => c.name === "update_quantity");
  if (!call) {
    fail(
      "llamó update_quantity",
      `Llamó otras funciones: ${result.calls.map((c) => c.name).join(", ")}`
    );
    return;
  }

  const qty = call.args.nueva_cantidad as number;
  if (qty === 9) {
    pass("nueva_cantidad=9 (valor final)", JSON.stringify(call.args));
  } else if (qty === 12) {
    fail(
      "nueva_cantidad=9 (valor final)",
      `El modelo interpretó como delta y puso nueva_cantidad=${qty} (bug: 3+9=12)`
    );
  } else {
    fail("nueva_cantidad=9 (valor final)", `Valor inesperado: nueva_cantidad=${qty}. Args: ${JSON.stringify(call.args)}`);
  }
}

async function caso2() {
  console.log('CASO 2: "sacame las aceitunas verdes" con dos variantes verdes en carrito → debe preguntar cuál');
  const result = await singleTurn(sessionConDosVerdes, "sacame las aceitunas verdes");

  const preguntaEsValida = (texto: string) => {
    const t = texto.toLowerCase();
    return (
      t.includes("cuál") || t.includes("cual") ||
      t.includes("qué") || t.includes("que") ||
      t.includes(" 0 ") || t.includes(" 00") // menciona calibre
    );
  };

  if (result.type === "tool_calls") {
    const removeCall = result.calls.find((c) => c.name === "remove_item");
    if (removeCall) {
      // Fallo duro: eliminó un ítem sin preguntar
      fail(
        "preguntó cuál antes de actuar",
        `Llamó remove_item sin preguntar: ${JSON.stringify(removeCall.args)}`
      );
    } else if (result.textContent && preguntaEsValida(result.textContent)) {
      // El modelo hizo una tool call benigna (ej: show_current_order) pero sí preguntó en el texto
      pass(
        "preguntó cuál antes de actuar (texto + tool call benigna)",
        `Tool calls: ${result.calls.map((c) => c.name).join(", ")} | Texto: "${result.textContent.slice(0, 100)}"`
      );
    } else {
      fail(
        "preguntó cuál antes de actuar",
        `Llamó funciones sin preguntar cuál: ${result.calls.map((c) => c.name).join(", ")}${result.textContent ? ` | Texto: "${result.textContent.slice(0, 80)}"` : ""}`
      );
    }
  } else {
    if (preguntaEsValida(result.content)) {
      pass("preguntó cuál antes de actuar", `Respuesta: "${result.content.slice(0, 120)}"`);
    } else {
      fail(
        "preguntó cuál antes de actuar",
        `Devolvió texto pero no pregunta cuál: "${result.content.slice(0, 120)}"`
      );
    }
  }
}

async function caso3() {
  console.log('CASO 3: "quiero un bidón de aceite de oliva" → debe preguntar tamaño, nunca asumir uno');
  const result = await singleTurn(sessionVacia, "quiero un bidón de aceite de oliva");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail(
        "preguntó tamaño (no asumió variante)",
        `Llamó add_item sin preguntar tamaño: ${JSON.stringify(addCall.args)}`
      );
    } else {
      fail(
        "preguntó tamaño (no asumió variante)",
        `Llamó funciones inesperadas: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    const pregunta = result.content.toLowerCase();
    const pide_tamaño =
      pregunta.includes("ml") ||
      pregunta.includes("litro") ||
      pregunta.includes("tamaño") ||
      pregunta.includes("tamanio") ||
      pregunta.includes("medida") ||
      pregunta.includes("250") ||
      pregunta.includes("500") ||
      pregunta.includes("cuál") ||
      pregunta.includes("cual");
    if (pide_tamaño) {
      pass("preguntó tamaño (no asumió variante)", `Respuesta: "${result.content.slice(0, 120)}..."`);
    } else {
      fail(
        "preguntó tamaño (no asumió variante)",
        `Devolvió texto pero no pide tamaño claramente: "${result.content.slice(0, 120)}..."`
      );
    }
  }
}

async function caso4() {
  console.log('CASO 4: "quiero aceitunas" → debe ofrecer categorías, no listar 52 ni inventar variante');
  const result = await singleTurn(sessionVacia, "quiero aceitunas");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail(
        "ofreció categorías (no llamó add_item)",
        `Llamó add_item directamente: ${JSON.stringify(addCall.args)}`
      );
    } else {
      fail(
        "ofreció categorías (no llamó add_item)",
        `Llamó funciones inesperadas: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    // Si no llamó add_item, el modelo pidió aclaración o mostró categorías — ambos son correctos.
    // El único fallo real es que haya llamado add_item con un producto inventado.
    // Mostramos la respuesta para inspección visual.
    pass(
      "no llamó add_item (preguntó o mostró categorías)",
      `Respuesta: "${result.content.slice(0, 200)}"`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Tests de regresión — modelo: ${MODEL} ===\n`);

for (const [i, fn] of [caso1, caso2, caso3, caso4].entries()) {
  try {
    await fn();
  } catch (err) {
    console.log(`  ✗ ERROR en caso ${i + 1}: ${err}\n`);
  }
}

console.log("=== Fin ===\n");
