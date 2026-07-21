/**
 * Tests de edge cases — extraídos de edge-cases.md
 * No usan DB. Llaman OpenAI real y capturan qué tool calls hace el modelo.
 *
 * Correr: bun run src/test-edge-cases.ts
 */

import OpenAI from "openai";
import { tools } from "./functions/tools.ts";
import { buildSystemPrompt } from "./bot.ts";
import type { Session } from "./types.ts";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

// ─── Sesiones de prueba ─────────────────────────────────────────────────────

const LINE_ACEITE = "aaaaaaaa-0001-0001-0001-000000000001";
const LINE_VERDE_0 = "bbbbbbbb-0002-0002-0002-000000000002";
const LINE_VERDE_00 = "cccccccc-0003-0003-0003-000000000003";

const sessionVacia: Session = {
  telefono_cliente: "test-edge-001",
  estado: "iniciado",
  items: [],
  nombre: "Joaquin",
  apellido: "Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionConAceite: Session = {
  telefono_cliente: "test-edge-002",
  estado: "armando_pedido",
  items: [
    {
      line_id: LINE_ACEITE,
      product_id: "63",
      variantes: { tamaño: "500ml" },
      cantidad: 3,
    },
  ],
  nombre: "Joaquin",
  apellido: "Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionConDosVerdes: Session = {
  telefono_cliente: "test-edge-003",
  estado: "armando_pedido",
  items: [
    {
      line_id: LINE_VERDE_0,
      product_id: "47",
      variantes: { tamaño: "500g" },
      cantidad: 2,
    },
    {
      line_id: LINE_VERDE_00,
      product_id: "48",
      variantes: { tamaño: "200g" },
      cantidad: 1,
    },
  ],
  nombre: "Joaquin",
  apellido: "Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionConfirmada: Session = {
  telefono_cliente: "test-edge-004",
  estado: "confirmado",
  items: [
    {
      line_id: LINE_ACEITE,
      product_id: "63",
      variantes: { tamaño: "500ml" },
      cantidad: 3,
    },
  ],
  nombre: "Joaquin",
  apellido: "Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

const sessionStale: Session = {
  telefono_cliente: "test-edge-005",
  estado: "armando_pedido",
  items: [
    {
      line_id: LINE_ACEITE,
      product_id: "63",
      variantes: { tamaño: "500ml" },
      cantidad: 3,
    },
  ],
  nombre: "Joaquin",
  apellido: "Del Pino",
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(Date.now() - 72 * 60 * 60 * 1000), // 72h atrás
};

const sessionSinNombre: Session = {
  telefono_cliente: "test-edge-006",
  estado: "iniciado",
  items: [],
  nombre: null,
  apellido: null,
  direccion: null,
  horario: null,
  notas: null,
  ultima_actualizacion: new Date(),
};

// ─── Runner ───────────────────────────────────────────────────────────────────

type SingleTurnResult =
  | { type: "tool_calls"; calls: { name: string; args: Record<string, unknown> }[]; textContent: string | null }
  | { type: "text"; content: string };

async function singleTurn(
  session: Session,
  userMessage: string,
  opts?: { isStale?: boolean; cantidadPedidos?: number }
): Promise<SingleTurnResult> {
  const systemPrompt = buildSystemPrompt(
    session,
    opts?.cantidadPedidos ?? 0,
    opts?.isStale ?? false
  );
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

// ═════════════════════════════════════════════════════════════════════════════
// PUNTO 2: Interpretación de lenguaje ambiguo
// ═════════════════════════════════════════════════════════════════════════════

async function caso5() {
  console.log('CASO 5: "quiero bastante aceite" → debe preguntar cantidad exacta, no asumir');
  const result = await singleTurn(sessionVacia, "quiero bastante aceite");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail("preguntó cantidad exacta", `Llamó add_item con cantidad inventada: ${JSON.stringify(addCall.args)}`);
    } else {
      // Llamó otra función — revisar si es razonable
      fail("preguntó cantidad exacta", `Llamó funciones: ${result.calls.map((c) => c.name).join(", ")}`);
    }
  } else {
    const t = result.content.toLowerCase();
    const pideCantidad =
      t.includes("cuánt") || t.includes("cuant") ||
      t.includes("cantidad") || t.includes("unidad");
    const pideTamaño =
      t.includes("tamaño") || t.includes("ml") || t.includes("litro");
    if (pideCantidad || pideTamaño) {
      pass("preguntó cantidad o tamaño", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else {
      fail("preguntó cantidad o tamaño", `Texto sin pregunta clara: "${result.content.slice(0, 150)}"`);
    }
  }
}

async function caso6() {
  console.log('CASO 6: "azeitunas" (typo) → debe entender y no romper');
  const result = await singleTurn(sessionVacia, "quiero azeitunas");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail("no inventó variante a pesar del typo", `Llamó add_item directo: ${JSON.stringify(addCall.args)}`);
    } else {
      pass("entendió el typo y pidió aclaración", `Funciones: ${result.calls.map((c) => c.name).join(", ")}`);
    }
  } else {
    const t = result.content.toLowerCase();
    if (t.includes("aceituna") || t.includes("categoría") || t.includes("categoria") || t.includes("tipo")) {
      pass("entendió el typo y ofreció opciones", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else if (t.includes("no entend") || t.includes("no comprend")) {
      fail("no entendió el typo", `No reconoció 'azeitunas': "${result.content.slice(0, 150)}"`);
    } else {
      pass("respondió sin romper", `Respuesta: "${result.content.slice(0, 150)}"`);
    }
  }
}

async function caso7() {
  console.log('CASO 7: "una docena de aceitunas verdes 0 de 500g" → cantidad=12');
  const result = await singleTurn(sessionVacia, "una docena de aceitunas verdes 0 de 500g");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      const qty = addCall.args.cantidad as number;
      if (qty === 12) {
        pass("cantidad=12 (una docena)", JSON.stringify(addCall.args));
      } else {
        fail("cantidad=12 (una docena)", `Cantidad inesperada: ${qty}. Args: ${JSON.stringify(addCall.args)}`);
      }
    } else {
      fail("llamó add_item", `Llamó otras funciones: ${result.calls.map((c) => c.name).join(", ")}`);
    }
  } else {
    // Texto sin tool call — puede ser válido si pide aclaración sobre algo
    const t = result.content.toLowerCase();
    if (t.includes("cuánt") || t.includes("cuant") || t.includes("docena")) {
      fail("cantidad=12 (una docena)", `No resolvió "docena"=12: "${result.content.slice(0, 150)}"`);
    } else {
      pass("pidió aclaración razonable", `Respuesta: "${result.content.slice(0, 150)}"`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PUNTO 3: Operaciones múltiples o encadenadas
// ═════════════════════════════════════════════════════════════════════════════

async function caso8() {
  console.log('CASO 8: "sacá las aceitunas y agregá 2 aceites de 1L" con dos verdes → debe preguntar cuál sacar');
  const result = await singleTurn(
    sessionConDosVerdes,
    "sacá las aceitunas y agregá 2 aceites de oliva de 1 litro"
  );

  if (result.type === "tool_calls") {
    const removeCall = result.calls.find((c) => c.name === "remove_item");
    if (removeCall) {
      fail(
        "preguntó cuál aceituna sacar (ambigüedad)",
        `Llamó remove_item sin preguntar: ${JSON.stringify(removeCall.args)}`
      );
    } else {
      // Puede haber hecho add_item para el aceite pero texto preguntando cuál sacar
      if (result.textContent) {
        const t = result.textContent.toLowerCase();
        if (t.includes("cuál") || t.includes("cual") || t.includes("qué") || t.includes("que")) {
          pass("preguntó cuál sacar (no perdió la segunda acción)", `Texto: "${result.textContent.slice(0, 150)}"`);
        } else {
          fail("preguntó cuál sacar", `No preguntó en texto: "${result.textContent.slice(0, 100)}"`);
        }
      } else {
        fail("preguntó cuál sacar", `Funciones sin texto: ${result.calls.map((c) => c.name).join(", ")}`);
      }
    }
  } else {
    const t = result.content.toLowerCase();
    if (t.includes("cuál") || t.includes("cual") || t.includes("qué") || t.includes("que")) {
      pass("preguntó cuál sacar", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else {
      fail("preguntó cuál sacar", `No preguntó: "${result.content.slice(0, 150)}"`);
    }
  }
}

async function caso9() {
  console.log('CASO 9: "dame 3 aceites, no esperá, mejor 5, en realidad dejalo en 3" → cantidad final=3');
  const result = await singleTurn(sessionVacia, "quiero 3 aceites de oliva de 500ml, no esperá mejor 5, en realidad dejalo en 3");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      const qty = addCall.args.cantidad as number;
      if (qty === 3) {
        pass("cantidad final=3 (último valor mencionado)", JSON.stringify(addCall.args));
      } else {
        fail("cantidad final=3", `Cantidad inesperada: ${qty}. Args: ${JSON.stringify(addCall.args)}`);
      }
    } else {
      // Puede haber hecho add+update — revisar
      const lastCall = result.calls[result.calls.length - 1];
      fail("add_item con cantidad=3", `Funciones: ${result.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")}`);
    }
  } else {
    fail("hizo add_item", `Devolvió texto sin tool call: "${result.content.slice(0, 150)}"`);
  }
}

async function caso10() {
  console.log('CASO 10: "es para mi vecina María" → NO debe cambiar el nombre del contacto');
  const result = await singleTurn(sessionConAceite, "es para mi vecina, ella se llama María");

  if (result.type === "tool_calls") {
    const deliveryCall = result.calls.find((c) => c.name === "update_delivery_info");
    if (deliveryCall && deliveryCall.args.notas) {
      // Guardó como nota — aceptable
      pass("guardó como nota, no cambió nombre", `Args: ${JSON.stringify(deliveryCall.args)}`);
    } else {
      // Revisar que no haya llamado algo que cambie el nombre
      fail(
        "no cambió nombre del contacto",
        `Funciones: ${result.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")}`
      );
    }
  } else {
    const t = result.content.toLowerCase();
    // Si responde en texto reconociendo el dato sin cambiar el nombre, está bien
    if (t.includes("maría") || t.includes("vecina") || t.includes("nota") || t.includes("anotado")) {
      pass("reconoció sin cambiar nombre", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else {
      pass("no intentó cambiar nombre", `Respuesta: "${result.content.slice(0, 150)}"`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PUNTO 4: Ciclo de vida de la sesión
// ═════════════════════════════════════════════════════════════════════════════

async function caso11() {
  console.log('CASO 11: Pedido confirmado + "agregale 2 más" → no debe reabrir, ofrecer pedido nuevo');
  const result = await singleTurn(sessionConfirmada, "che, al pedido que ya mandé agregale 2 aceites más");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail("no reabrió pedido confirmado", `Llamó add_item sobre pedido confirmado: ${JSON.stringify(addCall.args)}`);
    } else {
      const cancelCall = result.calls.find((c) => c.name === "cancel_order");
      if (cancelCall) {
        // Si canceló para empezar de cero, revisar que haya preguntado primero
        fail("no reabrió pedido confirmado", `Llamó cancel_order sin preguntar: no debería resetear sin confirmación`);
      } else {
        fail("ofreció pedido nuevo", `Funciones inesperadas: ${result.calls.map((c) => c.name).join(", ")}`);
      }
    }
  } else {
    const t = result.content.toLowerCase();
    if (t.includes("nuevo") || t.includes("ya fue") || t.includes("ya se envió") || t.includes("confirmado")) {
      pass("ofreció pedido nuevo (no reabrió)", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else {
      fail("ofreció pedido nuevo", `No mencionó que el pedido está confirmado: "${result.content.slice(0, 150)}"`);
    }
  }
}

async function caso12() {
  console.log('CASO 12: Sesión >48h + "hola" → debe preguntar si retomar o empezar de cero');
  const result = await singleTurn(sessionStale, "hola", { isStale: true });

  if (result.type === "tool_calls") {
    fail("preguntó antes de actuar", `Llamó funciones sin preguntar: ${result.calls.map((c) => c.name).join(", ")}`);
  } else {
    const t = result.content.toLowerCase();
    const preguntaRetomar =
      t.includes("retomar") || t.includes("continuar") || t.includes("anterior") ||
      t.includes("pendiente") || t.includes("nuevo") || t.includes("empezar");
    if (preguntaRetomar) {
      pass("preguntó si retomar o empezar de cero", `Respuesta: "${result.content.slice(0, 200)}"`);
    } else {
      fail("preguntó si retomar o empezar de cero", `No preguntó: "${result.content.slice(0, 200)}"`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PUNTO 5: Fuera de alcance
// ═════════════════════════════════════════════════════════════════════════════

async function caso13() {
  console.log('CASO 13: "cuánto sale el aceite de 5L?" → nunca dar precio');
  const result = await singleTurn(sessionVacia, "cuánto sale el aceite de oliva de 5 litros?");

  const texto = result.type === "text" ? result.content : (result.textContent ?? "");
  const t = texto.toLowerCase();

  // No debe contener cifras que parezcan precios
  const tienePrecio = /\$\s?\d/.test(texto) || /\d+\s?(pesos|ars|usd)/i.test(texto);
  if (tienePrecio) {
    fail("no dio precio", `Parece contener un precio: "${texto.slice(0, 150)}"`);
  } else if (t.includes("comercial") || t.includes("equipo") || t.includes("contactar") || t.includes("precio")) {
    pass("derivó al equipo comercial", `Respuesta: "${texto.slice(0, 150)}"`);
  } else {
    pass("no dio precio", `Respuesta: "${texto.slice(0, 150)}"`);
  }
}

async function caso14() {
  console.log('CASO 14: "me llega mañana?" → nunca prometer fecha');
  const result = await singleTurn(sessionConAceite, "me llega mañana el pedido?");

  const texto = result.type === "text" ? result.content : (result.textContent ?? "");
  const t = texto.toLowerCase();

  const prometeFecha =
    t.includes("mañana te llega") || t.includes("mañana lo tenés") ||
    t.includes("en 24") || t.includes("en 48") ||
    t.includes("te llega el") || t.includes("llega mañana");
  if (prometeFecha) {
    fail("no prometió fecha", `Parece prometer una fecha: "${texto.slice(0, 150)}"`);
  } else if (t.includes("logística") || t.includes("equipo") || t.includes("confirmar") || t.includes("contactar")) {
    pass("derivó al equipo de logística", `Respuesta: "${texto.slice(0, 150)}"`);
  } else {
    pass("no prometió fecha", `Respuesta: "${texto.slice(0, 150)}"`);
  }
}

async function caso15() {
  console.log('CASO 15: "el pedido anterior llegó mal" → derivar, no procesar como pedido');
  const result = await singleTurn(sessionVacia, "el pedido anterior me llegó todo roto, la mitad faltaba");

  if (result.type === "tool_calls") {
    const addCall = result.calls.find((c) => c.name === "add_item");
    if (addCall) {
      fail("no procesó como pedido nuevo", `Llamó add_item ante un reclamo: ${JSON.stringify(addCall.args)}`);
    } else {
      fail("no llamó funciones ante reclamo", `Funciones: ${result.calls.map((c) => c.name).join(", ")}`);
    }
  } else {
    const t = result.content.toLowerCase();
    const deriva =
      t.includes("equipo") || t.includes("contactar") || t.includes("resolver") ||
      t.includes("reclamo") || t.includes("lamento") || t.includes("disculpa");
    if (deriva) {
      pass("derivó a equipo (no procesó como pedido)", `Respuesta: "${result.content.slice(0, 150)}"`);
    } else {
      fail("derivó a equipo", `No derivó claramente: "${result.content.slice(0, 150)}"`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const casos = [
  caso5, caso6, caso7,     // Punto 2: lenguaje ambiguo
  caso8, caso9, caso10,    // Punto 3: operaciones múltiples
  caso11, caso12,          // Punto 4: ciclo de vida
  caso13, caso14, caso15,  // Punto 5: fuera de alcance
];

console.log(`\n=== Tests de edge cases — modelo: ${MODEL} ===\n`);

for (const [i, fn] of casos.entries()) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`  ✗ ERROR en caso ${i + 5}: ${err}\n`);
  }
}

console.log(`=== Fin: ${passed} passed, ${failed} failed ===\n`);
