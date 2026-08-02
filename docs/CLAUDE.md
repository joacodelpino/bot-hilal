# CLAUDE.md — Asistente de pedidos WhatsApp (Hilal Olivas) — **V2**

Este archivo es el contexto de arranque para Claude Code en este repo. Leelo completo antes de tocar código. Si algo acá contradice lo que encontrás en el código real, preguntá antes de asumir cuál es la verdad vigente.

> **Este documento describe la V2.** La V1 (bot autónomo que respondía directo al cliente) está tageada como `v1.0.0`. Ver sección "Por qué existe la V2" para entender qué cambió y por qué.

## Qué es este proyecto

Un **asistente de IA para agentes humanos** que atienden pedidos por WhatsApp para Hilal (fábrica de aceitunas y aceite de oliva, La Rioja).

El sistema tiene dos partes que se venden juntas:

1. **Atención omnicanal (Chatwoot)** — el equipo de Hilal atiende WhatsApp desde múltiples computadoras simultáneamente, con historial centralizado, etiquetas, respuestas predefinidas y métricas para el dueño. Esto por sí solo ya resuelve la limitación de WhatsApp Web (una sola sesión abierta a la vez).

2. **Asistente de IA (este bot)** — analiza cada mensaje del cliente en background y le deja al agente **notas privadas** en Chatwoot con: transcripción de audios, productos identificados en el catálogo, carrito sugerido, historial del cliente y qué datos faltan. El agente decide qué responder; el bot nunca le habla al cliente.

Al confirmar un pedido, el agente ejecuta un comando y el bot lo envía al backend de **HilalSistema-V2** (CRM) para que el dueño lo vea en su panel.

Este es un **repo separado e independiente** del CRM. No comparte base de datos con él. Se comunican únicamente por HTTP.

## Por qué existe la V2

La V1 era un bot autónomo: el LLM controlaba la conversación completa (decidía qué preguntar, cuándo llamar tools, cómo redactar cada respuesta) y hablaba directo con el cliente por WhatsApp.

**Por qué se descartó ese enfoque:**

- El system prompt llegó a 12 reglas que competían entre sí. Cada fix generaba una regresión en otro lado: arreglar el `line_id` visible rompía el mensaje de cierre del carrito; arreglar la inyección de prompt hacía que el bot rechazara pedidos legítimos ("¿podrías cambiar mi nombre?"); arreglar la confirmación causaba doble pregunta antes de confirmar.
- El comportamiento era **no determinístico**. El mismo input podía producir respuestas distintas. Con un solo cliente de prueba ya era impredecible; con 10 clientes simultáneos era inmanejable.
- **Todo error llegaba directo al cliente final.** Un bug de prompt no era un bug interno: era un mensaje equivocado en el WhatsApp de un cliente real de Hilal.
- El fix natural (agregar más reglas al prompt) era exactamente el patrón que hizo fallar al bot viejo de n8n. Estábamos repitiendo la historia con mejor sintaxis.

**Qué cambia en V2:**

El LLM deja de tener autoridad sobre la conversación. Su output ya no va al cliente — va al agente humano como sugerencia. El humano siempre tiene la última palabra.

| | V1 | V2 |
|---|---|---|
| Quién le habla al cliente | El bot | El agente humano |
| Rol del LLM | Decide y redacta | Analiza y sugiere |
| Si el LLM se equivoca | El cliente lo ve | El agente lo ignora |
| System prompt | 12 reglas apiladas | Extractor de intención |
| Estado conversacional | En la DB del bot | En la cabeza del agente |
| Testeable | No (no determinístico) | Sí (output interno) |

**Lo que no cambió**: la integración con Meta, Chatwoot, el CRM, el catálogo estructurado, la transcripción de audio y toda la capa de seguridad. Esa infraestructura era sólida y se reutiliza tal cual.

## Stack

- **Runtime**: Bun (igual que el backend del CRM, no Node/Express)
- **Lenguaje**: TypeScript
- **ORM**: Prisma
- **Base de datos**: PostgreSQL propia del bot (Supabase, schemas `public` = producción y `staging`)
- **LLM**: OpenAI con function calling (nunca JSON en texto libre parseado a mano)
- **Transcripción**: OpenAI `gpt-4o-mini-transcribe` (configurable via `OPENAI_TRANSCRIPTION_MODEL`)
- **Canal de entrada**: WhatsApp Cloud API oficial de Meta v22.0
- **Interfaz del agente**: Chatwoot self-hosted
- **Infraestructura**: Dokploy, en la misma VPS donde corre el CRM

## No negociables de producto (V2)

1. **El bot NUNCA le envía mensajes al cliente final.** Todo output del LLM va como nota privada en Chatwoot, visible solo para agentes. Si encontrás código que llama `sendTextMessage()` con contenido generado por el LLM, es un bug.
2. **El agente siempre puede ignorar la sugerencia.** Las notas privadas son informativas, nunca acciones automáticas. La única acción del bot que produce efectos externos es el envío del pedido al CRM, y requiere un comando explícito del agente.
3. **Nunca asumir una variante no mencionada.** Si un producto tiene `requires_specification = true` y falta el tamaño, la nota privada debe decir explícitamente qué falta y cuáles son las opciones — no elegir una.
4. **El bot nunca escribe directo en la base de datos del CRM.** Solo POST a `/api/orders/incoming`.
5. **Precios y fechas de entrega los maneja el agente.** El bot no los conoce ni los sugiere.

## Cómo funciona (flujo del agente)

```
Cliente escribe/manda audio por WhatsApp
        ↓
Llega a Chatwoot (el agente lo ve en su bandeja)
        ↓
El bot analiza en background y deja una NOTA PRIVADA:
  - Transcripción (si era audio)
  - Productos identificados en el catálogo
  - Carrito sugerido acumulado
  - Qué falta (tamaño, calibre, cantidad)
  - Contexto del cliente (recurrente, último pedido)
        ↓
El agente lee la nota y le responde al cliente
(a mano o con respuestas predefinidas de Chatwoot)
        ↓
Cuando el pedido está completo, el agente ejecuta:
  /enviar_pedido
        ↓
El bot valida el payload y lo manda al CRM
        ↓
Nota privada: "✅ Pedido enviado al CRM" o el error
```

## Comandos del agente

El agente controla al bot escribiendo comandos como **nota privada** en Chatwoot. El bot los detecta vía webhook (`message_created` con `private: true`) y los ejecuta.

| Comando | Qué hace |
|---|---|
| `/pedido` | Muestra el carrito sugerido actual |
| `/agregar <texto>` | Agrega un producto al carrito (el bot resuelve el `product_id`) |
| `/quitar <n>` | Quita la línea número n del carrito |
| `/cantidad <n> <cant>` | Cambia la cantidad de la línea n (valor final, no delta) |
| `/nombre <nombre>` | Registra el nombre del cliente |
| `/repetir` | Carga el último pedido confirmado del cliente como base |
| `/limpiar` | Vacía el carrito sugerido |
| `/enviar_pedido` | Valida y envía el pedido al CRM |

Los comandos son determinísticos: se parsean con código, no con LLM. Solo `/agregar` usa el LLM para resolver texto libre a `product_id` + variantes.

## Catálogo

Fuente: `data/catalog.csv` (52 productos). Columnas: `product_id`, `product_name`, `variant_options`, `requires_specification`, `category`, `aliases`.

- 52 productos es poco volumen — **no hace falta vector search/RAG**, alcanza con matching estructurado.
- `category` está completa (11 categorías). El bot la usa para agrupar términos genéricos en sus sugerencias.
- `aliases` está incompleta a propósito — solo tiene ejemplos confirmados (calibre 0=grande, 00=gigante, 1=medianas). No inventar aliases nuevos sin marcarlos como pendientes de confirmación con el dueño.
- `"Aji"` (id 46) y `"Aji huchukita"` (id 45) son **productos distintos**, no una duplicación. Confirmado con el cliente — tratarlos como entradas independientes del catálogo.

## Estado en la base de datos

### `pedidos_en_curso`

Guarda el **carrito sugerido** que el bot va armando. No guarda estado conversacional (eso vive en la cabeza del agente y en el historial visible de Chatwoot).

| Campo | Tipo | Notas |
|---|---|---|
| `telefono_cliente` | String (PK) | Teléfono E.164 sin "+" |
| `estado` | String | `"en_curso"` \| `"confirmado"` |
| `items` | JSON | Array de `CartItem` con `line_id` |
| `nombre`, `apellido` | String? | Del cliente |
| `direccion`, `horario`, `notas` | String? | Metadata de entrega (opcional) |
| `ultima_actualizacion` | DateTime | Auto-updated |

**Eliminado en V2**: la columna `historial` (mensajes del LLM). El bot ya no mantiene conversación — analiza cada mensaje de forma independiente. Era la fuente de los bugs de doble confirmación y de las regresiones cruzadas.

**Simplificado en V2**: `estado` ya no tiene `"escalado"` ni `"iniciado"` — no hay escalación porque el humano siempre está a cargo.

### `contactos`

Sin cambios respecto a V1.

| Campo | Tipo | Notas |
|---|---|---|
| `telefono` | String (PK) | Teléfono E.164 sin "+" |
| `nombre_apellido` | String? | Nombre completo |
| `primera_vez` | DateTime | Primera interacción |
| `ultima_interaccion` | DateTime | Auto-updated |
| `cantidad_pedidos_confirmados` | Int | Contador |
| `ultimo_pedido_items` | JSON? | Snapshot para `/repetir` |

## Conocimiento de dominio rescatado (sigue vigente)

- **Palabras que describen envase pero no son tamaño válido**: `bidón`, `bidoncito`, `envase`, `frasco`, `frasquito`, `botella`, `botellita`, `lata`, `latita`, `pote`, `potecito`, `tarro`, `tarrito`, `vasito`. Si aparecen sin tamaño, la nota privada debe marcar el tamaño como faltante.
- **Calibres son productos distintos**, no variantes: verdes 0 (id 47) y verdes 00 (id 48) tienen `product_id` diferentes. Una sugerencia que no distingue calibre está incompleta.
- **`update_quantity` recibe valor final, no delta.** "cambia los 3 por 9" → 9, nunca 12.
- **Cada línea del carrito tiene `line_id` único.** Las operaciones apuntan a `line_id`, nunca a re-match de texto contra `product_name`.

## Casos de prueba obligatorios

Los 4 casos de regresión de V1 siguen aplicando, pero ahora se verifican sobre el **contenido de la nota privada**, no sobre lo que el cliente recibe:

1. "cambia los 3 aceites por 9" → el carrito sugerido queda en 9, no en 12
2. "sacame las aceitunas verdes" con dos variantes verdes en el carrito → la nota marca la ambigüedad y lista ambas opciones, no elige una
3. "quiero un bidón de aceite de oliva" → la nota marca el tamaño como faltante y lista las opciones
4. "quiero aceitunas" sin más detalle → la nota sugiere las categorías relevantes, no inventa una variante

Casos nuevos de V2:

5. El bot NUNCA envía un mensaje al cliente — verificar con grep que no hay llamadas a `sendTextMessage()` con contenido del LLM
6. Comando `/enviar_pedido` con carrito vacío → error claro en nota privada, no POST al CRM
7. Comando mal escrito (`/enviarpedido`) → mensaje de ayuda con los comandos válidos

## Estructura de carpetas

```
bot-hilal/
├── CLAUDE.md              (este archivo)
├── data/
│   └── catalog.csv
├── prisma/
│   └── schema.prisma
├── src/
│   ├── whatsapp/          (webhook Meta, transcripción de audio)
│   ├── chatwoot/          (espejado + notas privadas + parsing de comandos)
│   ├── catalog/           (carga y matching del CSV)
│   ├── analysis/          (V2: extractor de intención del LLM)
│   ├── commands/          (V2: parsing y ejecución de comandos del agente)
│   ├── session/           (carrito sugerido y contactos)
│   └── crm-client.ts      (único punto que le habla al CRM)
└── package.json
```

## Seguridad (sin cambios respecto a V1)

Todo lo implementado en la Fase 4 sigue vigente y es obligatorio:

- **Firma de webhook de Meta**: HMAC-SHA256 sobre raw body con `timingSafeEqual`. El bot no arranca sin `META_APP_SECRET`.
- **Rate limiting**: 20 msg/min por teléfono, 200/min global. Configurables por env.
- **Deduplicación por `message_id`**: TTL de 5 minutos, previene reprocesar retries de Meta.
- **Enmascaramiento de teléfonos en logs**: `maskPhone()` en todo `console.log/warn/error`.
- **Error handling global**: `uncaughtException` y `unhandledRejection` no tiran el proceso.
- **Sin raw SQL**: todo vía Prisma parametrizado.

Nota: la mitigación de prompt injection de V1 es **menos crítica en V2** porque el output del LLM no llega al cliente. Se mantiene el logging de patrones sospechosos, pero un intento exitoso de inyección solo ensucia una nota privada que el agente puede ignorar.

## Preguntas abiertas

- ¿El bot debe sugerir pedir dirección/horario, o eso se coordina siempre después por el agente? (Hilal atiende mayoristas; precio y logística se negocian aparte.) — **pendiente de confirmar con el dueño**
- Aliases reales de clientes para categorías grandes (rellenas, calibre vidrio/PET) — **pendiente de conversación con el dueño**
- **Perfil del equipo de atención** — ¿Son empleados con años en la empresa que conocen el catálogo de memoria, o hay rotación? Esto define cuánto detalle necesitan las notas privadas y cuántos comandos hacen falta. **Hasta confirmarlo, asumimos rotación** (notas detalladas, set completo de comandos) — si resultan ser expertos, se poda. Es más barato podar que agregar sobre algo ya en producción.

## Contexto operativo conocido

- **2 puestos de atención** (2 computadoras). Equipo chico, curva de aprendizaje manejable.
- Los agentes **nunca usaron Chatwoot** — requiere sesión de onboarding antes de la entrega.
