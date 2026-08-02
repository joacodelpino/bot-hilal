# Roadmap / Pendientes — V2

Estado actual: **inicio del refactor a arquitectura human-in-the-loop**.

La V1 (bot autónomo) está tageada como `v1.0.0` y quedó funcional pero descartada por no determinismo. Ver `CLAUDE.md` → "Por qué existe la V2".

## Infraestructura ya lista (heredada de V1, no tocar)

Todo esto funciona y se reutiliza tal cual:

- ✅ Meta Cloud API v22.0 (webhook, envío, descarga de media)
- ✅ Chatwoot self-hosted con HTTPS y dominio propio
- ✅ Webhooks bidireccionales Meta ↔ bot ↔ Chatwoot
- ✅ Agentes, equipos, etiquetas y respuestas predefinidas configurados
- ✅ Transcripción de audio (`gpt-4o-mini-transcribe`)
- ✅ Catálogo estructurado (52 productos, 11 categorías)
- ✅ Integración con CRM (payload validado con Zod `.strict()`, timeout, reintentos)
- ✅ Seguridad: firma HMAC de Meta, rate limiting, deduplicación, enmascaramiento de logs, error handling global
- ✅ Deploy en Dokploy con Traefik + Let's Encrypt

## Refactor V2 — pendientes

### Bloque 1: Cambiar la dirección del output

- [ ] **Cortar el envío al cliente** — El bot deja de llamar `sendTextMessage()` con contenido del LLM. Verificar con grep que no queda ninguna ruta donde el output del análisis llegue a Meta.
- [ ] **Notas privadas** — Publicar el resultado del análisis como mensaje `private: true` en Chatwoot.
- [ ] **Plantillas de nota** — Formato fijo en código (transcripción / productos identificados / carrito sugerido / qué falta / contexto del cliente). Sin redacción libre del LLM.

### Bloque 2: Simplificar el motor

- [ ] **Reescribir el system prompt** — De 12 reglas conversacionales a un extractor de intención (~20 líneas). Sacar todo lo que sea política comercial, formato de respuesta o manejo de conversación.
- [ ] **Eliminar el historial de la DB** — Quitar la columna `historial` de `pedidos_en_curso` y toda la lógica de `trimHistorial`. Cada mensaje se analiza de forma independiente.
- [ ] **Simplificar `estado`** — Solo `"en_curso"` y `"confirmado"`. Eliminar `"iniciado"`, `"armando_pedido"`, `"escalado"`.
- [ ] **Eliminar la lógica de escalación** — `escalate_to_human`, `clearEscalation`, el flag de pausa por `Resolved`. En V2 el humano siempre está a cargo, no hay nada que escalar.

### Bloque 3: Comandos del agente

- [ ] **Parser de comandos** — Detectar notas privadas que empiezan con `/` en el webhook outbound de Chatwoot. Parsing determinístico con regex, no LLM.
- [ ] **Implementar los 8 comandos** — `/pedido`, `/agregar`, `/quitar`, `/cantidad`, `/nombre`, `/repetir`, `/limpiar`, `/enviar_pedido`.
- [ ] **Mensaje de ayuda** — Comando desconocido o mal escrito devuelve la lista de comandos válidos.

### Bloque 4: Testing

- [ ] **Tests de las plantillas** — Verificar que la nota privada tiene el formato esperado para cada tipo de análisis.
- [ ] **Tests de comandos** — Cada comando con input válido, input inválido y edge cases (carrito vacío, línea inexistente).
- [ ] **Portar los 4 casos de regresión de V1** — Verificados ahora sobre el contenido de la nota privada, no sobre lo que recibe el cliente.
- [ ] **Test de aislamiento** — Confirmar que ninguna ruta del código envía contenido del LLM al cliente.

### Bloque 5: Operación

- [ ] **Ambiente de staging** — Chip prepago comprado, falta registrarlo en Meta y levantar la instancia de staging con su propio `WHATSAPP_PHONE_NUMBER_ID`.
- [ ] **Configurar info de WhatsApp en Meta** — Foto de perfil, descripción del negocio, horarios.
- [ ] **Sesión de onboarding con el equipo** — 30 minutos mostrando el flujo diario en Chatwoot + los comandos del bot. Los empleados nunca usaron Chatwoot.
- [ ] **Documentar los comandos para el equipo** — Una hoja simple (no técnica) con los 8 comandos y cuándo usar cada uno.

## Decisiones pendientes de confirmar con el dueño

- [ ] **Dirección y horario** — ¿El agente los pide siempre, o se coordinan después? Hilal atiende mayoristas y precio/logística se negocian aparte, así que probablemente el pedido va al CRM sin esos datos.
- [ ] **Aliases de clientes** — Sinónimos reales que usan los clientes para categorías grandes (rellenas, calibre vidrio/PET).
- [ ] **Perfil del equipo** — ¿Cuántas personas atienden y hace cuánto trabajan ahí? ¿Hoy cómo cargan los pedidos al CRM? ¿Cuánto tardan por pedido? Define cuántos comandos y cuánto detalle en las notas privadas hacen falta.

### Resueltas

- ✅ **Producto "Aji" (id 46) vs "Aji huchukita" (id 45)** — Son productos distintos, no una duplicación.
- ✅ **Cantidad de puestos de atención** — 2 computadoras.

## Futuro (post-entrega a Hilal)

- [ ] **Replicabilidad multi-cliente** — Separar `bot-core` de `clients/<cliente>` con catálogo, plantillas y credenciales por cliente. Decisión explícita de NO hacer multi-tenant desde el día uno.
- [ ] **Métricas del asistente** — Cuántas sugerencias del bot usa el agente vs cuántas ignora. Sirve para medir si el bot realmente ahorra tiempo.
- [ ] **CI/CD** — Automatizar build + deploy en vez del proceso manual.
- [ ] **Cola distribuida** — Si se escala a múltiples instancias, migrar `phoneQueues` de memoria a Redis/BullMQ. Para el volumen de Hilal no hace falta.

## Deuda técnica conocida

- **Múltiples instancias de PrismaClient** — `session.ts`, `contacts.ts` y los tests crean cada uno la suya. Debería ser singleton.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0`** — Se usa para evitar errores de TLS con Chatwoot. Debería resolverse con certificados correctos.
- **`searchProducts()` sin usar** — Existe en `catalog.ts` pero nunca se invoca. En V2 podría ser útil para el comando `/agregar`.
- **Baja definitiva de n8n** — Las llamadas del CRM están desactivadas pero los contenedores de Evolution API / n8n siguen en la VPS. Falta `docker compose down -v`.
