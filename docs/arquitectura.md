# Arquitectura del sistema

## Diagrama general

```
                    ┌──────────────┐
                    │   Cliente    │
                    │  (WhatsApp)  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Meta Cloud  │
                    │  API v22.0   │
                    └──────┬───────┘
                           │ POST /webhook
                    ┌──────▼───────┐
                    │   Bot Hilal  │ Bun + TypeScript
                    │  (index.ts)  │ Puerto 3001
                    └──┬───┬───┬───┘
                       │   │   │
            ┌──────────┘   │   └──────────┐
            │              │              │
     ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
     │   Chatwoot   │ │  OpenAI  │ │  Supabase   │
     │ (Channel API)│ │   GPT-5o │ │ PostgreSQL  │
     └─────────────┘ └──────────┘ └─────────────┘
                                         │
                                  ┌──────▼──────┐
                                  │ HilalSistema │
                                  │   CRM (API)  │
                                  └─────────────┘
```

## Componentes

### 1. Servidor HTTP (`src/index.ts`)

Entry point de la aplicación. Levanta un servidor HTTP con `Bun.serve()` en el puerto 3001.

**Endpoints:**
- `GET /webhook` — Verificación del webhook de Meta (challenge/response)
- `POST /webhook` — Recepción de mensajes entrantes de WhatsApp
- `GET /health` — Health check (`{ status: "ok", ts: "..." }`)

**Cola por teléfono:** Cada mensaje entrante se encola por número de teléfono usando una `Map<string, Promise<void>>`. Esto serializa los mensajes del mismo cliente para evitar condiciones de carrera (dos mensajes simultáneos del mismo usuario pisándose el carrito).

### 2. Motor conversacional (`src/bot.ts`)

Construye el system prompt con el estado actual de la sesión y el catálogo completo, y ejecuta el loop de function calling de OpenAI.

**Flujo por turno:**
1. Carga sesión + contacto de la DB
2. Construye system prompt dinámico (estado, carrito, reglas, catálogo)
3. Carga historial de conversación previo de la sesión
4. Envía `[system, ...historial, user]` a OpenAI
5. Si el modelo devuelve tool_calls, las ejecuta y re-envía
6. Guarda el historial actualizado en la DB (cap 20 mensajes)
7. Aplica `stripMarkdown()` y retorna el texto final

**Historial:** Se persiste en la columna `historial` (JSON) de `pedidos_en_curso`. Guarda los mensajes completos de la API (incluye tool_calls y tool results). Se resetea en: `confirm_order`, `cancel_order`, `repeat_last_order`.

### 3. WhatsApp (`src/whatsapp/`)

- **`webhook.ts`** — Parsea el payload de Meta y extrae los mensajes relevantes. Ignora status updates (delivered, read).
- **`sender.ts`** — Envía mensajes de texto via Graph API v22.0 y descarga multimedia (para espejado en Chatwoot).

### 4. Chatwoot (`src/chatwoot/chatwoot.ts`)

Integración bidireccional con Chatwoot para soporte humano:

- **Espejado entrante:** Cada mensaje del cliente se replica en Chatwoot (texto o multimedia)
- **Espejado saliente:** Cada respuesta del bot se replica como mensaje outgoing
- **Pausa del bot:** Si un agente humano se asigna la conversación en Chatwoot, el bot se pausa (`isConversationPaused`). Se verifica dos veces: antes de procesar y antes de enviar la respuesta (para cubrir la ventana de tiempo mientras OpenAI procesa).
- **Atributos de contacto:** Sincroniza `tipo_cliente` (nuevo/recurrente) y `pedidos_confirmados` como custom attributes.

Usa un inbox de tipo `Channel::Api` (no WhatsApp), configurado con `CHATWOOT_INBOX_ID`.

### 5. Catálogo (`src/catalog/catalog.ts`)

Carga `data/catalog.csv` una sola vez al arrancar (singleton). El CSV tiene 52 productos con:
- `product_id`, `product_name`, `variant_options`, `requires_specification`, `category`, `aliases`

El catálogo completo se inyecta como JSON en el system prompt para que el LLM resuelva los `product_id`.

### 6. Sesión (`src/session/`)

- **`session.ts`** — CRUD sobre `pedidos_en_curso`. Operaciones de carrito: `addItem`, `removeItem`, `updateQuantity`, `replaceItem`, `clearSession`.
- **`contacts.ts`** — CRUD sobre `contactos`. Guarda `nombre_apellido`, `cantidad_pedidos_confirmados` y snapshot del último pedido.

### 7. Function calling (`src/functions/`)

- **`tools.ts`** — 10 definiciones de tools con JSON Schema para OpenAI
- **`handlers.ts`** — Lógica de ejecución de cada tool, con validación de catálogo y variantes

### 8. CRM (`src/crm-client.ts`)

Cliente HTTP minimalista. Al confirmar un pedido, envía un POST a `{CRM_BASE_URL}/api/orders/incoming` con el payload `ConfirmedOrder`.

## Base de datos

PostgreSQL (Supabase) con dos tablas:

### `pedidos_en_curso`
| Campo | Tipo | Descripción |
|---|---|---|
| `telefono_cliente` | String (PK) | Teléfono E.164 sin "+" |
| `estado` | String | "iniciado", "armando_pedido", "confirmado" |
| `items` | JSON | Array de `CartItem` |
| `historial` | JSON | Mensajes de conversación para el LLM |
| `nombre` | String? | Nombre del cliente |
| `apellido` | String? | Apellido del cliente |
| `direccion` | String? | Dirección de entrega |
| `horario` | String? | Horario preferido |
| `notas` | String? | Notas adicionales |
| `ultima_actualizacion` | DateTime | Auto-updated |

### `contactos`
| Campo | Tipo | Descripción |
|---|---|---|
| `telefono` | String (PK) | Teléfono E.164 sin "+" |
| `nombre_apellido` | String? | Nombre completo |
| `primera_vez` | DateTime | Primera interacción |
| `ultima_interaccion` | DateTime | Auto-updated |
| `cantidad_pedidos_confirmados` | Int | Contador de pedidos |
| `ultimo_pedido_items` | JSON? | Snapshot del último pedido (para repeat) |
