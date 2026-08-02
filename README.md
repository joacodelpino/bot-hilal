# Bot Hilal — Asistente de pedidos por WhatsApp (V2)

Asistente de IA para **Hilal**, fábrica de aceitunas y aceite de oliva de La Rioja, Argentina. No le habla al cliente: analiza cada mensaje de WhatsApp (incluyendo audio) y deja notas privadas en Chatwoot para que un agente humano atienda más rápido. El agente decide qué responder y, cuando el pedido está listo, lo envía al CRM con un comando.

> **V2 — arquitectura human-in-the-loop.** La V1 (bot autónomo que respondía directo al cliente) está tageada como `v1.0.0`. Se descartó por comportamiento no determinístico — ver [`docs/CLAUDE.md`](docs/CLAUDE.md) para el detalle completo de por qué.

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.2 |
| Lenguaje | TypeScript (strict, ESNext) |
| LLM | OpenAI (function calling, extracción de intención) |
| Transcripción | OpenAI `gpt-4o-mini-transcribe` |
| Base de datos | PostgreSQL (Supabase, schemas `public`/`staging`) via Prisma ORM |
| Mensajería | Meta WhatsApp Cloud API v22.0 |
| Interfaz del agente | Chatwoot self-hosted (Channel::Api) |
| CRM | HilalSistema-V2 (API REST interna) |
| Deploy | Docker + Dokploy + Traefik (VPS DonWeb) |

## Inicio rápido

```bash
# Instalar dependencias
bun install

# Configurar variables de entorno (ver docs/variables-de-entorno.md)
cp .env.example .env

# Generar Prisma Client y sincronizar schema con la DB
bun run db:generate
bun run db:push

# Desarrollo local (hot reload)
bun run dev

# Producción
bun run start
```

## Cómo funciona (resumen)

```
Cliente escribe/manda audio por WhatsApp
        ↓
Llega a Chatwoot — el agente lo ve en su bandeja
        ↓
El bot analiza en background y deja una NOTA PRIVADA:
  transcripción, productos identificados, carrito sugerido, qué falta
        ↓
El agente responde al cliente (Reply) con la info que necesite
        ↓
Cuando el pedido está completo, el agente escribe /enviar_pedido
como Nota privada
        ↓
El bot valida y envía el pedido al CRM
```

Detalle completo en [`docs/flujo-mensaje.md`](docs/flujo-mensaje.md) y la lista de comandos en [`docs/comandos-agente.md`](docs/comandos-agente.md).

## Estructura del proyecto

```
bot-hilal/
├── src/
│   ├── index.ts                 # Entry point — servidor HTTP, cola por teléfono,
│   │                             #   firma de Meta, rate limit, dedup
│   ├── analysis/
│   │   └── analyzer.ts          # Extractor de intención (system prompt corto,
│   │                             #   sin conversación ni historial)
│   ├── commands/
│   │   └── parser.ts            # Parsing y ejecución de comandos del agente (/…)
│   ├── types.ts                 # Interfaces TypeScript compartidas
│   ├── crm-client.ts            # Cliente HTTP para el CRM (Zod, timeout, retries)
│   ├── whatsapp/
│   │   ├── webhook.ts           # Verificación de firma + parsing del webhook de Meta
│   │   ├── sender.ts            # Envío de mensajes (solo reenvío de texto de agente)
│   │   └── transcription.ts     # Descarga + transcripción de audio
│   ├── chatwoot/
│   │   └── chatwoot.ts          # Espejado, notas privadas, parsing de comandos
│   ├── catalog/
│   │   └── catalog.ts           # Carga y queries sobre el catálogo (CSV)
│   ├── session/
│   │   ├── session.ts           # CRUD de pedidos_en_curso (carrito sugerido)
│   │   └── contacts.ts          # CRUD de contactos
│   ├── functions/
│   │   ├── tools.ts             # Definiciones de tools para el extractor
│   │   └── handlers.ts          # Validación de catálogo y variantes
│   └── tests/
│       ├── test-regression.ts   # Casos de regresión (verificados sobre notas privadas)
│       ├── test-edge-cases.ts   # Edge cases
│       ├── test-commands.ts     # Tests de los comandos del agente
│       └── test-no-client-leak.ts  # Verifica que el LLM nunca le habla al cliente
├── data/
│   └── catalog.csv              # Catálogo de 52 productos
├── prisma/
│   └── schema.prisma            # Schema de la DB (pedidos_en_curso, contactos)
├── Dockerfile                   # Build multi-stage con Bun
├── .dockerignore
├── package.json
└── tsconfig.json
```

## Documentación

- [CLAUDE.md — contexto de arquitectura y por qué existe V2](docs/CLAUDE.md)
- [Arquitectura del sistema](docs/arquitectura.md)
- [Flujo de un mensaje](docs/flujo-mensaje.md)
- [Comandos del agente](docs/comandos-agente.md)
- [Variables de entorno](docs/variables-de-entorno.md)
- [Deploy y operaciones](docs/deploy.md)
- [Roadmap / pendientes](docs/roadmap.md)

## Seguridad

Todo lo siguiente es obligatorio y no se debe deshabilitar:

- Verificación de firma HMAC-SHA256 del webhook de Meta (`META_APP_SECRET` requerida, el bot no arranca sin ella)
- Rate limiting por teléfono y global
- Deduplicación de mensajes por `message_id`
- Enmascaramiento de teléfonos en logs
- Validación Zod `.strict()` del payload al CRM

## Tests

```bash
# Tests de regresión (requiere OPENAI_API_KEY)
bun run src/tests/test-regression.ts

# Tests de edge cases
bun run src/tests/test-edge-cases.ts

# Tests de comandos del agente
bun run src/tests/test-commands.ts

# Verifica que ningún output del LLM llega al cliente
bun run src/tests/test-no-client-leak.ts

# Test de concurrencia (requiere bot corriendo)
BOT_URL=http://localhost:3001 bun run src/tests/test-concurrency.ts
```

## Licencia

Proyecto privado — Hilal / Gestión Capital.
