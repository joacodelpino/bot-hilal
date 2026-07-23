# Flujo de un mensaje

Paso a paso de lo que ocurre desde que el cliente envía un mensaje por WhatsApp hasta que recibe la respuesta del bot.

## Secuencia completa

```
Cliente envía "Quiero 2 aceitunas verdes 0 de 500g"
        │
        ▼
1. Meta Cloud API recibe el mensaje
        │
        ▼
2. POST /webhook → index.ts
   - parseIncomingMessages() extrae los mensajes del payload
   - Responde 200 inmediatamente a Meta
        │
        ▼
3. enqueue(telefono, ...) serializa el procesamiento
   - Si hay otro mensaje del mismo teléfono procesándose, espera
        │
        ▼
4. mirrorAndCheckStatus() → chatwoot.ts
   - Busca o crea el contacto en Chatwoot
   - Actualiza custom_attributes (tipo_cliente, pedidos_confirmados)
   - Busca o crea conversación en el inbox API
   - Espeja el mensaje entrante en Chatwoot
   - Verifica si hay un agente humano asignado (bot_paused)
        │
        ▼
5. ¿bot_paused?
   - SÍ → return (el agente humano maneja la conversación)
   - NO → continuar
        │
        ▼
6. ¿Es multimedia (audio/imagen/documento)?
   - SÍ → Responder "escribime en texto" y return
   - NO → continuar con texto
        │
        ▼
7. processMessage(telefono, texto) → bot.ts
   a. Carga sesión + contacto de la DB (en paralelo)
   b. Detecta si la sesión está inactiva (>48h con items)
   c. Construye system prompt con: estado, carrito, reglas, catálogo
   d. Carga historial de conversación de la sesión
   e. Arma messages = [system, ...historial, user]
   f. Llama a OpenAI con tools
        │
        ▼
8. ¿OpenAI devuelve tool_calls?
   - SÍ → ejecuta cada tool (add_item, remove_item, etc.)
          → agrega resultados al array messages
          → vuelve a llamar a OpenAI (loop)
   - NO → toma el texto de la respuesta
        │
        ▼
9. Guarda historial actualizado en la DB
   - Mensajes nuevos de este turno se agregan al historial existente
   - Se recorta a 20 mensajes, siempre empezando con un user message
        │
        ▼
10. stripMarkdown() limpia asteriscos y formato markdown
        │
        ▼
11. Recheck: ¿bot_paused? (un agente pudo asignarse mientras OpenAI procesaba)
    - SÍ → return sin enviar
    - NO → continuar
        │
        ▼
12. sendTextMessage() → envía la respuesta por WhatsApp
        │
        ▼
13. mirrorBotReply() → espeja la respuesta en Chatwoot como outgoing
        │
        ▼
14. Cliente recibe la respuesta
```

## Ejemplo: turno con tool calling

Cuando el cliente dice "Quiero 2 aceitunas verdes 0 de 500g", el flujo con OpenAI es:

```
→ OpenAI recibe:
  [system] "Sos el asistente de Hilal... CATÁLOGO: [{id:47, name:'Aceitunas (vidrio) verdes 0'...}]"
  [user]   "Quiero 2 aceitunas verdes 0 de 500g"

← OpenAI responde:
  tool_calls: [{ name: "add_item", args: { product_id: "47", variantes: { tamaño: "500g" }, cantidad: 2 } }]

→ Bot ejecuta add_item:
  - Valida product_id 47 existe en catálogo ✓
  - Valida variante "500g" está en variant_options ✓
  - Agrega al carrito en la DB
  - Retorna: "Agregado: Aceitunas (vidrio) verdes 0. Pedido actualizado:\n1. Aceitunas (vidrio) verdes 0 500g × 2"

→ OpenAI recibe el resultado del tool y genera respuesta final:
  "Listo, te agregué 2 Aceitunas verdes 0 de 500g al pedido..."
```

## Manejo de concurrencia

Si el mismo cliente envía dos mensajes rápidos seguidos:

```
Mensaje 1: "Quiero aceite"     ──┐
Mensaje 2: "Y también aceitunas" ──┤
                                   │
                            enqueue(telefono)
                                   │
                        ┌──────────▼──────────┐
                        │  Msg 1 se procesa   │
                        │  primero (Promise)   │
                        └──────────┬──────────┘
                                   │ .then()
                        ┌──────────▼──────────┐
                        │  Msg 2 espera a que │
                        │  termine Msg 1      │
                        └─────────────────────┘
```

La cola en memoria (`phoneQueues`) garantiza que los mensajes del mismo teléfono se procesan secuencialmente, evitando que dos writes simultáneos pisen el carrito.
