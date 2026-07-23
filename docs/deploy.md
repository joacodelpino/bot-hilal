# Deploy y operaciones

## Infraestructura actual

```
┌────────────────────────────────────────────────┐
│              VPS DonWeb (66.97.38.101)         │
│              SSH puerto 5258                    │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │              Dokploy                      │  │
│  │  ┌────────────┐  ┌───────────────────┐   │  │
│  │  │  Traefik   │  │   bot-hilal       │   │  │
│  │  │  (reverse  │──│   Bun :3001       │   │  │
│  │  │   proxy)   │  └───────────────────┘   │  │
│  │  │            │  ┌───────────────────┐   │  │
│  │  │  HTTPS +   │  │   Chatwoot        │   │  │
│  │  │  Let's     │──│   Rails :3000     │   │  │
│  │  │  Encrypt   │  └───────────────────┘   │  │
│  │  └────────────┘  ┌───────────────────┐   │  │
│  │                  │   n8n (legacy)    │   │  │
│  │                  └───────────────────┘   │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
          │
          │ HTTPS
          ▼
  bot.hilalolivas.com.ar → Traefik → bot-hilal:3001
```

## Dominio

- **Dominio:** `bot.hilalolivas.com.ar`
- **DNS:** Registro A apuntando a `66.97.38.101` (configurado en el panel de DonWeb)
- **TLS:** Certificado automático via Let's Encrypt (Traefik certresolver)

## Docker

### Dockerfile

Multi-stage build con `oven/bun:1.2-alpine`:

1. Instala dependencias (`bun install --frozen-lockfile --production`)
2. Genera Prisma Client (`bunx prisma generate`)
3. Copia código fuente y datos
4. Expone puerto 3001
5. Ejecuta `bun run src/index.ts`

### Docker Compose (en Dokploy)

El bot se define como un servicio en el Docker Compose de Dokploy:

```yaml
bot-hilal:
  image: bot-hilal:latest
  restart: unless-stopped
  environment:
    - DATABASE_URL=${DATABASE_URL}
    - OPENAI_API_KEY=${OPENAI_API_KEY}
    - OPENAI_MODEL=${OPENAI_MODEL}
    - META_PHONE_NUMBER_ID=${META_PHONE_NUMBER_ID}
    - META_ACCESS_TOKEN=${META_ACCESS_TOKEN}
    - META_WEBHOOK_VERIFY_TOKEN=${META_WEBHOOK_VERIFY_TOKEN}
    - CRM_BASE_URL=${CRM_BASE_URL}
    - CRM_API_KEY=${CRM_API_KEY}
    - CHATWOOT_BASE_URL=${CHATWOOT_BASE_URL}
    - CHATWOOT_API_TOKEN=${CHATWOOT_API_TOKEN}
    - CHATWOOT_ACCOUNT_ID=${CHATWOOT_ACCOUNT_ID}
    - CHATWOOT_INBOX_ID=${CHATWOOT_INBOX_ID}
  networks:
    - dokploy-network
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.bot-hilal.rule=Host(`bot.hilalolivas.com.ar`)"
    - "traefik.http.routers.bot-hilal.entrypoints=websecure"
    - "traefik.http.routers.bot-hilal.tls.certresolver=letsencrypt"
    - "traefik.http.services.bot-hilal.loadbalancer.server.port=3001"
```

Las variables de entorno se configuran en la pestaña "Environment" de Dokploy (no con `env_file`, porque Dokploy corre en container y no tiene acceso a paths del host).

## Proceso de deploy

### 1. Pushear cambios

```bash
git add -A && git commit -m "..." && git push origin main
```

### 2. Build en la VPS

```bash
ssh -p 5258 root@66.97.38.101
cd /opt/bot-hilal
git pull
docker build -t bot-hilal:latest .
```

### 3. Redeploy en Dokploy

Desde la UI de Dokploy, hacer "Redeploy" en el servicio `bot-hilal`.

### 4. Verificar

```bash
curl https://bot.hilalolivas.com.ar/health
# → {"status":"ok","ts":"2026-07-23T..."}
```

## Operaciones comunes

### Ver logs

```bash
# En la VPS
docker logs -f $(docker ps -qf "name=bot-hilal")
```

### Limpiar sesión de un cliente

```bash
# Desde el repo local
bun -e "
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.pedidos_en_curso.update({
  where: { telefono_cliente: '549XXXXXXXXXX' },
  data: { estado: 'iniciado', items: [], historial: [], direccion: null, horario: null, notas: null },
});
console.log('Sesión limpiada');
await prisma.\$disconnect();
"
```

### Cambios en el schema de DB

Si se modifica `prisma/schema.prisma`:

```bash
bun run db:generate   # Regenera Prisma Client
bun run db:push       # Aplica cambios al schema en Supabase
```

No es necesario tocar Supabase manualmente; `db:push` se encarga.
