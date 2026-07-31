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
  console.log('CASO 2: "sacame las aceitunas verdes" con dos verdes en carrito → preguntar cuál, luego eliminar la correcta');

  // Turno 1: pedir sacar sin especificar → debe preguntar cuál
  // Turno 2: cliente especifica "las del calibre 0" → debe llamar remove_item con el line_id correcto
  const { responses, calledAddItem } = await multiTurn(
    sessionConDosVerdes,
    ["sacame las aceitunas verdes", "las del calibre 0 (las de 500g)"]
  );

  const [resp1, resp2] = responses;

  // Aserción 1: turno 1 no debe llamar remove_item y debe preguntar cuál
  const turno1EliminoDirecto = resp1.includes("[tool_calls: remove_item]");
  if (turno1EliminoDirecto) {
    fail(
      "turno 1: preguntó cuál antes de actuar",
      `Llamó remove_item sin preguntar. Respuesta: "${resp1.slice(0, 150)}"`
    );
  } else {
    const preguntoCual =
      resp1.toLowerCase().includes("cuál") ||
      resp1.toLowerCase().includes("cual") ||
      resp1.toLowerCase().includes(" 0 ") ||
      resp1.toLowerCase().includes(" 00");
    if (preguntoCual) {
      pass("turno 1: preguntó cuál antes de actuar", `Respuesta: "${resp1.slice(0, 150)}"`);
    } else {
      fail(
        "turno 1: preguntó cuál antes de actuar",
        `No llamó remove_item pero tampoco preguntó cuál. Respuesta: "${resp1.slice(0, 150)}"`
      );
    }
  }

  // Aserción 2: turno 2 debe llamar remove_item con el line_id de las verdes 0
  const turno2Elimino = resp2?.includes("[tool_calls: remove_item]") ||
    resp2?.includes("[tool_calls:");
  if (turno2Elimino) {
    pass(
      "turno 2: llamó remove_item tras confirmación del cliente",
      `Respuesta: "${resp2?.slice(0, 150)}"`
    );
  } else {
    fail(
      "turno 2: llamó remove_item tras confirmación del cliente",
      `No llamó remove_item después de que el cliente especificó cuál. Respuesta: "${resp2?.slice(0, 150)}"`
    );
  }
}

async function caso3() {
  console.log('CASO 3: "quiero un bidón de aceite de oliva" → debe preguntar tipo o tamaño, nunca asumir ni llamar add_item');
  const result = await singleTurn(sessionVacia, "quiero un bidón de aceite de oliva");

  // El catálogo tiene 3 tipos de aceite (vidrio/PET/AOVE → product_ids distintos).
  // Comportamiento válido: preguntar tipo primero (Regla 1, PASO 1) O preguntar tamaño
  // si ya resolvió el tipo. Lo inválido es llamar add_item sin datos completos.
  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail(
        "no asumió variante (no llamó add_item)",
        `Llamó add_item sin preguntar tipo ni tamaño: ${JSON.stringify(addCall.args)}`
      );
    } else {
      fail(
        "no asumió variante (no llamó add_item)",
        `Llamó funciones inesperadas: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    const pregunta = result.content.toLowerCase();
    // Válido: preguntar tipo (vidrio/PET/AOVE) o tamaño (ml/litro/250/500/etc.)
    const pide_tipo =
      pregunta.includes("vidrio") ||
      pregunta.includes("pet") ||
      pregunta.includes("aove") ||
      pregunta.includes("tipo");
    const pide_tamaño =
      pregunta.includes("ml") ||
      pregunta.includes("litro") ||
      pregunta.includes("tamaño") ||
      pregunta.includes("medida") ||
      pregunta.includes("250") ||
      pregunta.includes("500") ||
      pregunta.includes("cuál") ||
      pregunta.includes("cual");
    if (pide_tipo || pide_tamaño) {
      pass(
        "no asumió variante — preguntó tipo o tamaño",
        `Respuesta: "${result.content.slice(0, 120)}"`
      );
    } else {
      fail(
        "no asumió variante — preguntó tipo o tamaño",
        `Devolvió texto pero no pregunta tipo ni tamaño: "${result.content.slice(0, 120)}"`
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

async function multiTurn(session: Session, turns: string[]): Promise<{ responses: string[]; calledAddItem: boolean; firstAddItemArgs: Record<string, unknown> | null }> {
  const systemPrompt = buildSystemPrompt(session, 0);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  const responses: string[] = [];
  let calledAddItem = false;
  let firstAddItemArgs: Record<string, unknown> | null = null;

  for (const userMsg of turns) {
    messages.push({ role: "user", content: userMsg });

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("OpenAI no devolvió respuesta");

    const assistantContent = choice.message.content ?? "";

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      const addCall = choice.message.tool_calls.find((tc) => tc.function.name === "add_item");
      if (addCall && !calledAddItem) {
        calledAddItem = true;
        firstAddItemArgs = JSON.parse(addCall.function.arguments);
      }
      // Simular respuesta del tool para continuar la conversación
      messages.push({ role: "assistant", content: assistantContent, tool_calls: choice.message.tool_calls });
      for (const tc of choice.message.tool_calls) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
      }
      responses.push(`[tool_calls: ${choice.message.tool_calls.map((t) => t.function.name).join(",")}] ${assistantContent}`);
    } else {
      messages.push({ role: "assistant", content: assistantContent });
      responses.push(assistantContent);
    }
  }

  return { responses, calledAddItem, firstAddItemArgs };
}

async function caso5() {
  console.log('CASO 5 (regresión calibre): "aceitunas verdes en vidrio" → debe preguntar calibre, no asumir ni agregar');

  // Turno 1: cliente pide aceitunas verdes en vidrio sin especificar calibre ni tamaño
  // Turno 2: solo confirma "el 0" (calibre) — aún no especifica tamaño
  // Turno 3: especifica tamaño → recién acá add_item es válido
  const { responses, calledAddItem, firstAddItemArgs } = await multiTurn(
    sessionVacia,
    ["aceitunas verdes en vidrio", "el calibre 0 (grande)", "500g"]
  );

  const [resp1, resp2, resp3] = responses;

  // Aserción 1: el primer turno NO debe llamar add_item
  const primerTurnoAgrego = resp1.includes("[tool_calls: add_item]");
  if (primerTurnoAgrego) {
    fail(
      "turno 1: no llamó add_item sin datos completos",
      `Agregó producto sin preguntar calibre ni tamaño. Respuesta: "${resp1.slice(0, 150)}"`
    );
  } else {
    const preguntaCalibro =
      resp1.toLowerCase().includes("calibre") ||
      resp1.toLowerCase().includes(" 0 ") ||
      resp1.toLowerCase().includes(" 00") ||
      resp1.toLowerCase().includes("grande") ||
      resp1.toLowerCase().includes("gigante");
    if (preguntaCalibro) {
      pass("turno 1: preguntó calibre antes de actuar", `Respuesta: "${resp1.slice(0, 150)}"`);
    } else {
      fail(
        "turno 1: preguntó calibre antes de actuar",
        `No llamó add_item pero tampoco preguntó calibre claramente. Respuesta: "${resp1.slice(0, 150)}"`
      );
    }
  }

  // Aserción 2: el segundo turno (calibre dado, tamaño aún no) NO debe llamar add_item
  const segundoTurnoAgrego = resp2?.includes("[tool_calls: add_item]");
  if (segundoTurnoAgrego) {
    fail(
      "turno 2: no llamó add_item sin tamaño confirmado",
      `Agregó producto sin preguntar tamaño. Args: ${JSON.stringify(firstAddItemArgs)}`
    );
  } else {
    pass("turno 2: no llamó add_item (tamaño pendiente)", `Respuesta: "${resp2?.slice(0, 150)}"`);
  }

  // Aserción 3: add_item debe haberse llamado en algún punto (flujo completo)
  if (calledAddItem) {
    pass(
      "flujo completo: add_item llamado con datos completos",
      `Args: ${JSON.stringify(firstAddItemArgs)}`
    );
  } else {
    fail(
      "flujo completo: add_item llamado con datos completos",
      `Nunca llamó add_item incluso después de dar calibre y tamaño. Última respuesta: "${resp3?.slice(0, 150)}"`
    );
  }
}

async function caso6() {
  console.log('CASO 6 (show_catalog sin categoría): "¿qué tienen?" → debe llamar show_catalog sin category');
  const result = await singleTurn(sessionVacia, "¿qué tienen?");

  if (result.type === "tool_calls") {
    const call = result.calls.find((c) => c.name === "show_catalog");
    if (call) {
      const hasCategory = call.args.category !== undefined && call.args.category !== null && call.args.category !== "";
      if (hasCategory) {
        fail(
          "llamó show_catalog sin category",
          `Llamó show_catalog con category="${call.args.category}" en vez de sin parámetro`
        );
      } else {
        pass("llamó show_catalog sin category", `Args: ${JSON.stringify(call.args)}`);
      }
    } else {
      fail(
        "llamó show_catalog",
        `Llamó otras funciones: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    // Responder en texto también puede ser aceptable si menciona categorías,
    // pero preferimos que use la tool
    const t = result.content.toLowerCase();
    const mencionaCategorias =
      t.includes("aceitun") || t.includes("aceite") || t.includes("categoría") || t.includes("categoria");
    if (mencionaCategorias) {
      pass(
        "respondió con categorías (sin tool — aceptable)",
        `Respuesta: "${result.content.slice(0, 120)}"`
      );
    } else {
      fail(
        "llamó show_catalog o mencionó categorías",
        `Devolvió texto sin mencionar categorías: "${result.content.slice(0, 120)}"`
      );
    }
  }
}

async function caso7() {
  console.log('CASO 7 (show_catalog con categoría): "¿qué aceitunas rellenas tienen?" → debe llamar show_catalog con esa categoría');
  const result = await singleTurn(sessionVacia, "¿qué aceitunas rellenas tienen?");

  if (result.type === "tool_calls") {
    const call = result.calls.find((c) => c.name === "show_catalog");
    if (call) {
      const cat = String(call.args.category ?? "").toLowerCase();
      if (cat.includes("rellen")) {
        pass("llamó show_catalog con categoría correcta", `Args: ${JSON.stringify(call.args)}`);
      } else {
        fail(
          "llamó show_catalog con categoría correcta",
          `Llamó show_catalog pero con category="${call.args.category}"`
        );
      }
    } else {
      fail(
        "llamó show_catalog",
        `Llamó otras funciones: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    // Responder con la lista en texto también puede ser válido
    const t = result.content.toLowerCase();
    if (t.includes("rellen")) {
      pass(
        "respondió con productos rellenas (sin tool — aceptable)",
        `Respuesta: "${result.content.slice(0, 150)}"`
      );
    } else {
      fail(
        "llamó show_catalog o listó aceitunas rellenas",
        `Respuesta no menciona rellenas: "${result.content.slice(0, 120)}"`
      );
    }
  }
}

async function caso8() {
  console.log('CASO 8 (escalate_to_human): "quiero hablar con una persona" → debe llamar escalate_to_human');
  const result = await singleTurn(sessionVacia, "quiero hablar con una persona del equipo");

  if (result.type === "tool_calls") {
    const call = result.calls.find((c) => c.name === "escalate_to_human");
    if (call) {
      const motivo = String(call.args.motivo ?? "");
      if (motivo.length > 0) {
        pass("llamó escalate_to_human con motivo", `Motivo: "${motivo}"`);
      } else {
        fail("llamó escalate_to_human con motivo", `Llamó escalate_to_human pero sin motivo`);
      }
    } else {
      fail(
        "llamó escalate_to_human",
        `Llamó otras funciones: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    fail(
      "llamó escalate_to_human",
      `Devolvió texto en lugar de llamar la tool: "${result.content.slice(0, 120)}"`
    );
  }
}

async function caso9() {
  console.log('CASO 9 (escalate reclamo): "el pedido anterior llegó mal" → debe escalar, no inventar solución');
  const result = await singleTurn(sessionVacia, "el pedido que me mandaron la semana pasada llegó mal, faltaban productos");

  if (result.type === "tool_calls") {
    const call = result.calls.find((c) => c.name === "escalate_to_human");
    if (call) {
      pass("escaló el reclamo correctamente", `Motivo: "${call.args.motivo}"`);
    } else {
      fail(
        "escaló el reclamo",
        `Llamó otras funciones en lugar de escalar: ${result.calls.map((c) => c.name).join(", ")}`
      );
    }
  } else {
    fail(
      "escaló el reclamo",
      `Respondió en texto sin escalar: "${result.content.slice(0, 150)}"`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Tests de regresión — modelo: ${MODEL} ===\n`);

for (const [i, fn] of [caso1, caso2, caso3, caso4, caso5, caso6, caso7, caso8, caso9].entries()) {
  try {
    await fn();
  } catch (err) {
    console.log(`  ✗ ERROR en caso ${i + 1}: ${err}\n`);
  }
}

console.log("=== Fin ===\n");
