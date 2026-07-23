# Bot Hilal — Asistente de pedidos por WhatsApp

Bot conversacional para **Hilal**, fábrica de aceitunas y aceite de oliva de La Rioja, Argentina. Recibe pedidos por WhatsApp, los arma con ayuda de un LLM (GPT-4o) y los envía al CRM interno.

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.2 |
| Lenguaje | TypeScript (strict, ESNext) |
| LLM | OpenAI GPT-4o (function calling) |
| Base de datos | PostgreSQL (Supabase) via Prisma ORM |
| Mensajería | Meta WhatsApp Cloud API v22.0 |
| Soporte humano | Chatwoot (Channel::Api) |
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

## Estructura del proyecto

```
bot-hilal/
├── src/
│   ├── index.ts                 # Entry point — servidor HTTP + cola por teléfono
│   ├── bot.ts                   # System prompt + loop de tool calling + historial
│   ├── types.ts                 # Interfaces TypeScript compartidas
│   ├── crm-client.ts            # Cliente HTTP para el CRM
│   ├── whatsapp/
│   │   ├── webhook.ts           # Verificación y parsing del webhook de Meta
│   │   └── sender.ts            # Envío de mensajes y descarga de media
│   ├── chatwoot/
│   │   └── chatwoot.ts          # Espejado de mensajes + pausa por agente humano
│   ├── catalog/
│   │   └── catalog.ts           # Carga y queries sobre el catálogo (CSV)
│   ├── session/
│   │   ├── session.ts           # CRUD de pedidos_en_curso (Prisma)
│   │   └── contacts.ts          # CRUD de contactos (Prisma)
│   ├── functions/
│   │   ├── tools.ts             # Definiciones de tools para OpenAI
│   │   └── handlers.ts          # Lógica de ejecución de cada tool
│   └── tests/
│       ├── test-regression.ts   # 4 tests de regresión
│       ├── test-edge-cases.ts   # 11 tests de edge cases
│       ├── test-ttl.ts          # 2 tests de TTL de sesión
│       ├── test-concurrency.ts  # Test de concurrencia real
│       └── test-multiturn.ts    # 3 tests de conversación multi-turno
├── data/
│   └── catalog.csv              # Catálogo de 52 productos
├── prisma/
│   └── schema.prisma            # Schema de la DB
├── Dockerfile                   # Build multi-stage con Bun
├── .dockerignore
├── package.json
└── tsconfig.json
```

## Documentación

- [Arquitectura del sistema](docs/arquitectura.md)
- [Flujo de un mensaje](docs/flujo-mensaje.md)
- [Function calling (tools)](docs/function-calling.md)
- [Variables de entorno](docs/variables-de-entorno.md)
- [Deploy y operaciones](docs/deploy.md)
- [Roadmap / pendientes](docs/roadmap.md)

## Tests

```bash
# Tests de regresión (requiere OPENAI_API_KEY)
bun run src/tests/test-regression.ts

# Tests de edge cases
bun run src/tests/test-edge-cases.ts

# Tests de TTL de sesión
bun run src/tests/test-ttl.ts

# Test de conversación multi-turno
bun run src/tests/test-multiturn.ts

# Test de concurrencia (requiere bot corriendo)
BOT_URL=http://localhost:3001 bun run src/tests/test-concurrency.ts
```

## Licencia

Proyecto privado — Hilal / Gestión Capital.
