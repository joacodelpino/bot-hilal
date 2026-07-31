import type OpenAI from "openai";

/**
 * Definiciones de tools para OpenAI function calling.
 * Cada parámetro está tipado con JSON Schema — el modelo NO puede devolver
 * JSON en texto libre, tiene que llamar estas funciones.
 */
export const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_item",
      description:
        "Agregar un producto al pedido. Solo llamar si product_id y todas las variantes requeridas ya están resueltas.",
      parameters: {
        type: "object",
        properties: {
          product_id: {
            type: "string",
            description: "ID del producto según el catálogo.",
          },
          variantes: {
            type: "object",
            description:
              'Variantes seleccionadas. Para productos con requires_specification=true, debe incluir al menos {"tamaño": "valor"}. Valor debe estar en variant_options del producto.',
            additionalProperties: { type: "string" },
          },
          cantidad: {
            type: "number",
            description: "Cantidad a agregar. Mínimo 1.",
          },
        },
        required: ["product_id", "variantes", "cantidad"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_item",
      description:
        "Quitar un ítem del pedido por su line_id. Si hay ambigüedad (más de un ítem que podría coincidir con lo que el cliente quiere sacar), preguntar cuál antes de llamar esta función.",
      parameters: {
        type: "object",
        properties: {
          line_id: {
            type: "string",
            description: "line_id del ítem a eliminar.",
          },
        },
        required: ["line_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_quantity",
      description:
        "Cambiar la cantidad de un ítem. IMPORTANTE: nueva_cantidad es el valor FINAL absoluto, no un delta. Si el cliente dice 'cambia los 3 por 9', nueva_cantidad=9 (no 3+9=12).",
      parameters: {
        type: "object",
        properties: {
          line_id: {
            type: "string",
            description: "line_id del ítem a modificar.",
          },
          nueva_cantidad: {
            type: "number",
            description: "Cantidad final absoluta. Mínimo 1.",
          },
        },
        required: ["line_id", "nueva_cantidad"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_item",
      description:
        "Reemplazar un ítem por otro producto diferente, manteniendo el mismo line_id y cantidad.",
      parameters: {
        type: "object",
        properties: {
          line_id: {
            type: "string",
            description: "line_id del ítem a reemplazar.",
          },
          product_id_nuevo: {
            type: "string",
            description: "ID del nuevo producto.",
          },
          variantes: {
            type: "object",
            description: "Variantes del nuevo producto.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["line_id", "product_id_nuevo", "variantes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order",
      description:
        "Confirmar el pedido actual. Solo llamar cuando el cliente haya confirmado explícitamente. Envía el pedido al CRM.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "Cancelar y limpiar el pedido en curso.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_current_order",
      description: "Mostrar el estado actual del pedido al cliente.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_last_order",
      description:
        "Cargar el último pedido confirmado del cliente como punto de partida. Solo disponible para clientes recurrentes.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_client_name",
      description:
        "Guardar el nombre (y opcionalmente apellido) del cliente. Llamar esta función apenas el cliente diga su nombre, ANTES de continuar con el pedido.",
      parameters: {
        type: "object",
        properties: {
          nombre: {
            type: "string",
            description: "Nombre del cliente.",
          },
          apellido: {
            type: "string",
            description: "Apellido del cliente (si lo dio).",
          },
        },
        required: ["nombre"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_catalog",
      description:
        "Mostrar productos disponibles. Sin category: lista las categorías disponibles. Con category: lista los productos de esa categoría con sus variantes de tamaño. Usar cuando el cliente pregunta qué hay disponible o por una categoría específica. NO usar si el cliente ya sabe lo que quiere y lo pide directamente.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Nombre de la categoría a mostrar (ej: 'Aceitunas rellenas', 'Aceites de oliva'). Omitir para listar todas las categorías disponibles.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Derivar la conversación a un agente humano del equipo. Llamar cuando el cliente pide hablar con una persona, hace un reclamo sobre un pedido, o el bot no puede resolver la consulta tras 2 intentos.",
      parameters: {
        type: "object",
        properties: {
          motivo: {
            type: "string",
            description:
              "Razón de la escalación. Se guarda como nota interna en Chatwoot para el agente. Ej: 'Cliente solicita hablar con una persona', 'Reclamo sobre pedido anterior', 'Consulta sobre precio que excede las capacidades del bot'.",
          },
        },
        required: ["motivo"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_delivery_info",
      description:
        "Registrar datos de entrega: dirección, horario preferido y notas. Usar solo para metadata de entrega, nunca para completar variantes de un producto.",
      parameters: {
        type: "object",
        properties: {
          direccion: {
            type: "string",
            description: "Dirección de entrega.",
          },
          horario: {
            type: "string",
            description: "Horario preferido de entrega.",
          },
          notas: {
            type: "string",
            description: "Notas adicionales para la entrega.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];
