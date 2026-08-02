# Arquitectura del sistema — V2

> Documento actualizado para la arquitectura **human-in-the-loop**. Para la arquitectura de V1 (bot autónomo), ver el tag `v1.0.0`.

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
                    ┌──────▼────────────┐
                    │   Bot Hilal       │ Bun + TypeScript
                    │   (index.ts)      │ Puerto 3001
                    └──┬────┬────┬──────┘
                       │    │    │
        ┌──────────────┘    │    └───────────┐
        │                   │                │
 ┌──────▼───────┐   ┌───────▼──────┐  ┌──────▼──────┐
 │  Chatwoot    │   │   OpenAI     │  │  Supabase   │
 │              │   │  Análisis +  │  │ PostgreSQL  │
 │ ┌──────────┐ │   │ transcripción│  └─────────────┘
 │ │  AGENTE  │ │   └──────────────┘
 │ │  HUMANO  │ │
 │ └────┬─────┘ │
 └──────┼───────┘
        │ /enviar_pedido
        ▼
 ┌──────────────┐
 │ HilalSistema │
 │  CRM (API)   │
 └──────────────┘
```

**La diferencia clave con V1**: el bot no tiene una flecha de salida hacia el cliente. Todo lo que produce el LLM entra a Chatwoot como nota privada. El único camino hacia el cliente pasa por el agente humano.

## Componentes

### 1. Servidor HTTP (`src/index.ts`)

Entry point. Levanta un servidor HTTP con `Bun.serve()` en el puerto 3001.

**Endpoints:**
- `GET /webhook` — Verificación del webhook de Meta (challenge/response)
- `POST /webhook` — Mensajes entrantes de WhatsApp. **Verifica firma HMAC-SHA256 antes de procesar.**
- `POST /webhooks/chatwoot-outbound` — Eventos de Chatwoot: mensajes de agente (se reenvían al cliente) y notas privadas (se parsean como comandos)
- `GET /health` — Health check

**Middlewares en orden:**
1. Verificación de firma de Meta (solo `/webhook`)
2. Deduplicación por `message_id` (TTL 5 min)
3. Rate limiting (20/min por teléfono, 200/min global)

**Cola por teléfono:** `Map<string, Promise<void>>` que serializa el procesamiento de mensajes del mismo cliente para evitar condiciones de carrera sobre el carrito.

### 2. Motor de análisis (`src/analysis/`)

**Reemplaza al `bot.ts` de V1.** Su trabajo es acotado: recibe un mensaje del cliente y devuelve un análisis estructurado. No redacta respuestas, no mantiene conversación, no decide qué preguntar.

**Flujo:**
1. Recibe el texto del mensaje (ya transcrito si era audio)
2. Carga el carrito actual y el contexto del contacto
3. Llama a OpenAI con un system prompt corto (~20 líneas) y function calling
4. El LLM devuelve intención estructurada: qué productos identificó, qué variantes faltan, qué acción sugiere
5. Se arma la nota privada con plantillas fijas y se envía a Chatwoot

**System prompt de V2:** solo describe la tarea de extracción, el formato de salida y el catálogo. No tiene reglas de conversación, de formato de respuesta, ni de política comercial — todo eso lo maneja el agente humano.

### 3. WhatsApp (`src/whatsapp/`)

- **`webhook.ts`** — Parsea el payload de Meta. Ignora status updates.
- **`sender.ts`** — Envía mensajes de texto vía Graph API v22.0. **En V2 solo se usa para reenviar mensajes escritos por el agente**, nunca contenido generado por el LLM.
- **`transcription.ts`** — Descarga el audio de Meta y lo transcribe con `gpt-4o-mini-transcribe` (español forzado). El texto resultante entra al pipeline como si fuera un mensaje escrito.

### 4. Chatwoot (`src/chatwoot/`)

El componente más importante de V2 — es la interfaz de trabajo del agente.

- **Espejado entrante:** cada mensaje del cliente se replica en Chatwoot (texto o multimedia)
- **Notas privadas:** el output del análisis se publica como mensaje `private: true`, visible solo para agentes
- **Reenvío saliente:** cuando un agente escribe un mensaje público en Chatwoot, se reenvía al cliente por WhatsApp
- **Parsing de comandos:** las notas privadas que empiezan con `/` se interpretan como comandos del agente
- **Atributos de contacto:** sincroniza `tipo_cliente` y `pedidos_confirmados` como custom attributes

**Filtros del webhook outbound (4 capas, en orden):**

Chatwoot dispara un webhook por cada evento de una conversación. Estas capas descartan lo que no corresponde procesar, hasta quedarse solo con lo accionable.

| # | Filtro | Por qué |
|---|---|---|
| 1 | `event !== "message_created"` → ignorar | Chatwoot manda eventos de todo tipo (conversación creada, status cambiado, etiqueta agregada). Solo interesan los mensajes nuevos. |
| 2 | `message_type !== "outgoing"` → ignorar | Los mensajes `incoming` (del cliente) ya llegan por el webhook de Meta. Procesarlos acá los duplicaría. |
| 3 | `private === true` → **parsear como comando** | Los `outgoing` pueden ser públicos (van al cliente) o notas privadas. **En V1 las privadas se ignoraban; en V2 son el canal de comandos del agente.** |
| 4 | `botMessageIds.has(msgId)` → ignorar | Cuando el bot escribe una nota privada, Chatwoot le avisa de vuelta. Sin este filtro habría loop infinito. |

**Lo que pasa los 4 filtros**: un mensaje público escrito por un agente humano → se reenvía al cliente por WhatsApp.

**Riesgo residual conocido**: `botMessageIds` vive en memoria. Si el bot se reinicia, pierde el registro — un webhook de un mensaje creado antes del restart podría reenviarse al cliente. Poco frecuente y mitigado parcialmente por la deduplicación por `message_id`.

### 5. Comandos del agente (`src/commands/`)

**Nuevo en V2.** Parsea y ejecuta los comandos que el agente escribe como notas privadas.

El parsing es determinístico (regex sobre el texto, no LLM). La única excepción es `/agregar <texto libre>`, que usa el LLM para resolver el texto a `product_id` + variantes — y si el resultado es ambiguo, devuelve las opciones en vez de elegir.

Cada comando devuelve una nota privada de confirmación o error.

### 6. Catálogo (`src/catalog/catalog.ts`)

Sin cambios respecto a V1. Carga `data/catalog.csv` una vez al arrancar (singleton). 52 productos con `product_id`, `product_name`, `variant_options`, `requires_specification`, `category`, `aliases`.

Expone `getAllProducts()`, `getCategories()`, `getProductsByCategory()`.

### 7. Sesión (`src/session/`)

- **`session.ts`** — CRUD sobre `pedidos_en_curso`. Operaciones de carrito: `addItem`, `removeItem`, `updateQuantity`, `replaceItem`, `clearSession`. **En V2 estas operaciones las dispara el agente vía comandos o el análisis del bot como sugerencia, no el LLM directamente.**
- **`contacts.ts`** — CRUD sobre `contactos`. Sin cambios.

### 8. CRM (`src/crm-client.ts`)

Cliente HTTP. Al ejecutar `/enviar_pedido`, valida el payload con Zod (`.strict()`, rechaza campos extra como precios) y hace POST a `{CRM_BASE_URL}/api/orders/incoming`.

**Endurecimiento (heredado de V1):**
- Timeout de 8 segundos con `AbortController`
- Reintentos: hasta 2 con backoff (500ms, 1500ms) solo para 5xx/red/timeout
- 400/422 no se reintentan (error de datos, no transitorio)
- 401 loggea el problema de API key explícitamente

## Base de datos

PostgreSQL (Supabase), schemas `public` (producción) y `staging`.

### `pedidos_en_curso`
| Campo | Tipo | Descripción |
|---|---|---|
| `telefono_cliente` | String (PK) | Teléfono E.164 sin "+" |
| `estado` | String | `"en_curso"` \| `"confirmado"` |
| `items` | JSON | Array de `CartItem` |
| `nombre` | String? | Nombre del cliente |
| `apellido` | String? | Apellido del cliente |
| `direccion` | String? | Dirección de entrega |
| `horario` | String? | Horario preferido |
| `notas` | String? | Notas adicionales |
| `ultima_actualizacion` | DateTime | Auto-updated |

**Cambios respecto a V1:**
- ❌ Se elimina `historial` (mensajes del LLM) — el bot no mantiene conversación
- 🔄 `estado` se simplifica: se eliminan `"iniciado"`, `"armando_pedido"` y `"escalado"`

### `contactos`

Sin cambios respecto a V1.

| Campo | Tipo | Descripción |
|---|---|---|
| `telefono` | String (PK) | Teléfono E.164 sin "+" |
| `nombre_apellido` | String? | Nombre completo |
| `primera_vez` | DateTime | Primera interacción |
| `ultima_interaccion` | DateTime | Auto-updated |
| `cantidad_pedidos_confirmados` | Int | Contador de pedidos |
| `ultimo_pedido_items` | JSON? | Snapshot para `/repetir` |
