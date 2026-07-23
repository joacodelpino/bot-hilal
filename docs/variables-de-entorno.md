# Variables de entorno

Todas las variables requeridas para ejecutar el bot. Configurar en `.env` (local) o en el panel de Environment de Dokploy (producción).

## Obligatorias

### Base de datos
| Variable | Descripción | Ejemplo |
|---|---|---|
| `DATABASE_URL` | Connection string PostgreSQL (Supabase pooler) | `postgresql://postgres.xxx:password@aws-0-xx.pooler.supabase.com:5432/postgres` |

### OpenAI
| Variable | Descripción | Ejemplo |
|---|---|---|
| `OPENAI_API_KEY` | API key de OpenAI | `sk-proj-...` |
| `OPENAI_MODEL` | Modelo a usar (default: `gpt-4o`) | `gpt-4o` |

### Meta WhatsApp Cloud API
| Variable | Descripción | Ejemplo |
|---|---|---|
| `META_PHONE_NUMBER_ID` | ID del número de teléfono en Meta Business | `123456789012345` |
| `META_ACCESS_TOKEN` | Token de acceso permanente de la app de Meta | `EAA...` |
| `META_WEBHOOK_VERIFY_TOKEN` | Token custom para verificación del webhook | `mi-token-secreto` |

### Chatwoot
| Variable | Descripción | Ejemplo |
|---|---|---|
| `CHATWOOT_BASE_URL` | URL base de Chatwoot (sin trailing slash) | `http://{VPS_IP}:3000` |
| `CHATWOOT_API_TOKEN` | Token de API del agente/admin en Chatwoot | `abc123...` |
| `CHATWOOT_ACCOUNT_ID` | ID de la cuenta en Chatwoot (default: `1`) | `1` |
| `CHATWOOT_INBOX_ID` | ID del inbox tipo Channel::Api | `3` |

### CRM
| Variable | Descripción | Ejemplo |
|---|---|---|
| `CRM_BASE_URL` | URL base del CRM HilalSistema-V2 | `https://crm.hilalolivas.com.ar` |
| `CRM_API_KEY` | API key para autenticación con el CRM | `key-...` |

## Opcionales

| Variable | Descripción | Default |
|---|---|---|
| `BOT_PORT` | Puerto HTTP del bot | `3001` |
| `OPENAI_BASE_URL` | URL base custom de OpenAI (para proxies) | (API oficial) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Desactivar validación TLS (solo dev) | `1` (activo) |

## Notas

- El `DATABASE_URL` de Supabase debe usar la URL del **pooler** (no la conexión directa) para evitar problemas de conexión desde Docker.
- El `META_ACCESS_TOKEN` debe ser un token permanente (System User Token), no un token temporal de desarrollo.
- El `CHATWOOT_BASE_URL` debe usar `http://` si Chatwoot está detrás de Traefik sin certificado propio.
- En Dokploy, las variables se configuran en la pestaña "Environment" del servicio, no con `env_file`.
