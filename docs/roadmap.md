# Roadmap / Pendientes

Estado actual: **MVP funcional**. El bot recibe pedidos por WhatsApp, los arma con IA y los espeja en Chatwoot.

## Pendientes para producción

### Prioridad alta

- [ ] **Conectar API del CRM** — Verificar que el endpoint `/api/orders/incoming` del CRM (HilalSistema-V2) acepte el payload `ConfirmedOrder`. Actualmente el POST se hace pero no se ha validado el formato contra el CRM real.
- [ ] **Transcripción de audio** — Actualmente el bot responde "escribime en texto" cuando recibe un audio. Implementar transcripción con OpenAI Whisper y procesar el texto resultante.
- [ ] **Mostrar MVP al cliente** — Requerimiento de ingeniería: validar el flujo completo con el equipo de Hilal, recoger feedback y ajustar reglas del system prompt.

### Prioridad media

- [ ] **Optimización del system prompt** — El catálogo completo (52 productos en JSON) se inyecta en cada turno. Evaluar: reducir el JSON a campos mínimos, o usar embeddings para enviar solo productos relevantes.
- [ ] **Tests de integración end-to-end** — Los tests actuales prueban lógica de tools con estado inyectado. Falta un test que simule una secuencia real de mensajes turno a turno (el test-multiturn es un primer paso).
- [ ] **Manejo de errores del CRM** — Si `sendOrderToCRM` falla, el pedido queda como "confirmado" en la sesión pero no llegó al CRM. Implementar retry o cola de fallidos.

### Prioridad baja / futuro

- [ ] **Replicabilidad multi-cliente** — Refactorizar para que el bot sea configurable por cliente (catálogo, system prompt, credenciales). Actualmente todo es hardcoded para Hilal.
- [ ] **Escalabilidad** — La cola por teléfono es in-memory. Para múltiples instancias del bot, migrar a una cola distribuida (Redis, BullMQ). Para el volumen actual de Hilal no es necesario.
- [ ] **Limpieza de código** — Eliminar imports no usados, consolidar instancias de PrismaClient (actualmente hay una por módulo), revisar types con `any`.
- [ ] **CI/CD** — Automatizar build + deploy con GitHub Actions o similar en vez del proceso manual (git pull + docker build + redeploy).
- [ ] **Métricas y observabilidad** — Logging estructurado, métricas de latencia por turno, tasa de errores de OpenAI, dashboard en Grafana o similar.
- [ ] **Rate limiting** — Limitar mensajes por teléfono por minuto para evitar abuso.

## Deuda técnica conocida

- **Múltiples instancias de PrismaClient** — `session.ts`, `contacts.ts` y los tests cada uno crean su propia instancia. Debería ser un singleton compartido.
- **`searchProducts()` no se usa** — La función existe en `catalog.ts` pero nunca se invoca. El matching de productos depende 100% del LLM.
- **Tests del webhook/sender sin mocks** — No hay tests unitarios para la capa de WhatsApp ni Chatwoot. Solo tests funcionales que requieren OpenAI.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0`** — Se usa en producción para evitar errores de TLS con Chatwoot. Debería resolverse con certificados correctos.
