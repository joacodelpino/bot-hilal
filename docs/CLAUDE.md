# CLAUDE.md — Bot de pedidos por WhatsApp (Hilal Olivas)

Este archivo es el contexto de arranque para Claude Code en este repo. Leelo completo antes de tocar código. Si algo acá contradice lo que encontrás en el código real, preguntá antes de asumir cuál es la verdad vigente.

## Qué es este proyecto

Un bot que recibe pedidos por WhatsApp para Hilal (fábrica de aceitunas y aceite de oliva, La Rioja), entiende el catálogo real con sus variantes, mantiene el estado del pedido mientras el cliente lo arma (agregar/quitar/modificar hasta confirmar), y al confirmarse lo envía al backend de otro sistema ya existente: **HilalSistema-V2** (CRM), para que el dueño lo vea y delegue el contacto con el cliente a un empleado.

Este es un **repo separado e independiente** del CRM. No comparte base de datos con él. Se comunican únicamente por HTTP.

## Por qué existe este proyecto

Hubo un intento previo con **n8n** (workflow con ~80 nodos) que no prosperó. No falló por usar un canal no oficial — de hecho ya usaba **Meta Cloud API oficial** (`graph.facebook.com/v22.0/.../messages`), eso está bien y hay que mantenerlo. Falló porque la interpretación de pedidos con múltiples variantes (tamaño, envase, tipo) y las operaciones de modificación (quitar, reemplazar, restar cantidad) dependían de un **system prompt de texto libre de ~150 líneas con reglas de prioridad apiladas** (ej. "la regla #0 tiene prioridad sobre la regla #3"), sin ningún schema que validara que el LLM las respetara. Es un patrón clásico de fragilidad por parcheo iterativo.

**La decisión de arquitectura central de este proyecto es reemplazar eso por function calling real** (tools con parámetros tipados, validados por schema) más validación determinística en código — no otro prompt más largo o más "inteligente".

No hay que redescubrir el diseño de negocio desde cero: hay conocimiento real extraído de esa implementación vieja (ver sección "Conocimiento rescatado" más abajo) que sí hay que preservar, solo que traducido a estructura de datos en vez de instrucción en lenguaje natural.

## Stack

- **Runtime**: Bun (igual que el backend del CRM, no Node/Express)
- **Lenguaje**: TypeScript
- **ORM**: Prisma
- **Base de datos**: PostgreSQL — **propia de este bot**, no la del CRM (tablas `pedidos_en_curso` y `contactos`)
- **LLM**: OpenAI, con **function calling / tool use** (nunca pedirle al modelo que devuelva JSON en texto libre para luego parsearlo)
- **Canal de entrada**: WhatsApp Cloud API oficial de Meta (webhook)
- **Visibilidad e intervención humana**: Chatwoot (módulo separado)
- **Infraestructura de destino**: Dokploy, en la misma VPS donde ya corre el CRM (como contenedor propio, aparte del contenedor del CRM)

## No negociables de producto

1. **Nunca asumir una variante no mencionada.** Si un producto tiene `requires_specification = true` y falta un dato (tamaño, envase, tipo), preguntar puntualmente ese dato — nunca inventarlo, nunca asumir un default.
2. **Nunca mostrar el catálogo completo salvo ambigüedad genuina.** Ver árbol de decisión abajo.
3. **Después de cada modificación del carrito, mostrar el pedido completo actualizado** antes de seguir, para que el cliente corrija en el momento si algo se interpretó mal.
4. **El bot nunca escribe directo en la base de datos del CRM.** Solo se comunica con él vía POST a su endpoint interno (`/api/orders/incoming` o el que esté vigente — confirmar contra el código real del CRM, no contra `PLAN_INTEGRACION_WHATSAPP_ORDERS_V2.md` a ciegas, porque ese doc menciona SQLite y el CRM real usa Postgres, así que puede estar desactualizado en otros puntos también).

## Árbol de decisión de aclaración

```
Cliente menciona un producto
        │
        ▼
¿Hay un alias o mención que resuelve TODAS las variantes requeridas
sin ambigüedad?
   SÍ → resolver directo, sin preguntar
   NO → ¿se puede acotar con una sola pregunta puntual (falta un único dato)?
         SÍ → preguntar solo ese dato (nunca el catálogo completo)
         NO (cliente genuinamente perdido, sin ninguna pista) →
              mostrar la gama de productos de la categoría relevante
              (no los 52 productos, solo la categoría si se pudo inferir)
```

Esto se implementa como **validación de datos en código**, nunca como instrucción de buena fe al LLM: la función correspondiente devuelve un estado de "falta variante X" si `requires_specification` es true y no está resuelta, y el código arma la pregunta puntual a partir de eso.

## Catálogo

Fuente: `data/ProductosHilal_categorizado (1).csv` (52 productos). Columnas: `product_id`, `product_name`, `variant_options`, `requires_specification`, `category`, `aliases`.

- 52 productos es poco volumen — **no hace falta vector search/RAG para esto**, alcanza con matching estructurado contra estas columnas.
- `category` ya está completa (11 categorías). Úsala para agrupar términos genéricos ("quiero aceitunas" → ofrecer categorías, no una lista plana de 52 nombres).
- `aliases` está incompleta a propósito — solo tiene ejemplos confirmados (calibre 0=grande, 00=gigante, 1=medianas, el envasado puede ser en vidrio o PET). El resto de los sinónimos reales de clientes todavía no están validados con el dueño de la fábrica. No inventar aliases nuevos sin marcarlos claramente como pendientes de confirmación.
- Hay un caso pendiente de resolver con el dueño: el producto `"Aji"` (id 46, antes `"Aji"`) tiene un comentario en la celda marcando posible conflicto/duplicación con `"Aji huchukita"` (id 45) — no asumir que son lo mismo ni que son distintos, preguntar si aparece en el flujo de trabajo.

## Estado conversacional (carrito con identidad)

```
tabla: pedidos_en_curso (Postgres propia del bot)
- telefono_cliente (clave)
- estado: "iniciado" | "armando_pedido" | "confirmado"
- items: JSON [{line_id, product_id, variantes: {...}, cantidad}, ...]
- nombre_apellido
- ultima_actualizacion
```

Cada línea del carrito tiene un `line_id` único dentro de la sesión. Las operaciones de modificación (quitar, reemplazar, cambiar cantidad) apuntan a un `line_id` específico, nunca a un re-match de texto libre contra `product_name`.

### Funciones de function calling (tools)

- `add_item(product_id, variantes, cantidad)`
- `remove_item(line_id)`
- `update_quantity(line_id, nueva_cantidad)` — **`nueva_cantidad` es el valor final, no un delta.** Esto es intencional: en el prompt viejo, distinguir "cambia los 3 aceites por 9" (resultado final: 9) de una suma era una fuente de bugs resuelta a fuerza de reglas de texto. Nombrando el parámetro como valor absoluto, la ambigüedad desaparece por diseño, no por instrucción.
- `replace_item(line_id, product_id_nuevo, variantes)`
- `confirm_order()`
- `cancel_order()`
- `show_current_order()`
- `repeat_last_order()` — ver sección de contactos recurrentes
- `update_delivery_info(direccion, horario, notas)` — solo para metadata de entrega, nunca para completar variantes de un producto

## Contactos recurrentes

```
tabla: contactos (Postgres propia del bot)
- telefono (clave)
- nombre_apellido
- primera_vez: DateTime
- ultima_interaccion: DateTime
- cantidad_pedidos_confirmados: Int
- ultimo_pedido_items: JSON (snapshot del último pedido confirmado)
```

- Si el teléfono ya existe en `contactos`, **no volver a pedir nombre y apellido** (a diferencia del bot viejo, que siempre lo pedía al arrancar la sesión).
- `repeat_last_order()` carga `ultimo_pedido_items` como punto de partida editable — el cliente puede seguir modificando desde ahí con las mismas funciones de agregar/quitar/reemplazar.
- Esta tabla es una capa de conveniencia conversacional del bot — no reemplaza el envío del pedido confirmado al CRM, que sigue pasando siempre.

## Integración con Chatwoot

Reconstruir como **módulo separado** del bot principal (en n8n vivía como workflow aparte, `Chatwoot_Mirror`, invocado por webhook desde el bot). Mantené esa separación acá: un módulo `chatwoot.ts` con una función tipo `mirrorAndCheckStatus(mensaje, telefono)` que el bot llama en cada mensaje entrante.

Contrato contra la API de Chatwoot (ya confirmado en el workflow viejo, no hay que rediseñarlo):
1. Normalizar el teléfono
2. Buscar el nombre del cliente ya conocido (tabla `contactos`)
3. `POST /api/v1/accounts/1/contacts/search` → si no existe, `POST /api/v1/accounts/1/contacts`
4. `PATCH /api/v1/accounts/1/contacts/{contact_id}` para mantener el nombre actualizado
5. `GET /api/v1/accounts/1/conversations` → crear una nueva si no hay conversación abierta
6. Si el mensaje es multimedia (audio/imagen): descargarlo de Meta y resubirlo a Chatwoot como adjunto
7. Espejar el mensaje a la conversación
8. Devolver al bot: `{ bot_paused: boolean, conv_id }`

**"Pausado" no es un flag custom** — es si la conversación en Chatwoot tiene un agente humano asignado (`has_agent`). Cuando el dueño o un empleado se asigna la conversación en Chatwoot, el bot deja de responder automático a ese cliente. Es funcionalidad nativa de Chatwoot, no hay que inventar un mecanismo de pausa aparte.

**Nuevo requisito** (no existía en la versión vieja): usar `custom_attributes` del contacto en Chatwoot para marcar si es cliente nuevo o recurrente (según `cantidad_pedidos_confirmados` en la tabla `contactos`), para que el dueño tenga ese contexto al abrir la conversación.

## Conocimiento rescatado del prompt viejo de n8n (no reinventar, solo migrar a código)

- **Palabras que describen envase pero no son un tamaño válido**: `bidón`, `bidoncito`, `envase`, `frasco`, `frasquito`, `botella`, `botellita`, `lata`, `latita`, `pote`, `potecito`, `tarro`, `tarrito`, `vasito`. Si el cliente usa una sin dar tamaño exacto, tratarlo como variante faltante — no asumir.
- **Agrupación de términos genéricos**: el prompt viejo agrupaba por coincidencia de substring en el nombre (frágil). Acá usar la columna `category` del excel en su lugar — es más preciso.
- **Prioridad absoluta de captura de nombre** mientras no esté confirmado: se mantiene, pero ahora se saltea automáticamente para contactos ya conocidos (el prompt viejo no tenía persistencia de clientes recurrentes, por eso siempre preguntaba).
- **Campos de `extracted_data`** para dirección de entrega, horario preferido y notas — se mantienen como parte del estado de la sesión (`pedidos_en_curso`), no como flags sueltos del prompt.

## Casos de prueba obligatorios antes de dar el bot por validado

Extraídos de fallas reales del bot anterior — no son hipotéticos, son regresiones conocidas:

1. "cambia los 3 aceites por 9" → cantidad final debe quedar en 9, no en 12 (no es un delta)
2. "sacame las aceitunas verdes" con más de una variante verde en el carrito → debe preguntar cuál, no borrar la primera que encuentre
3. "quiero un bidón de aceite de oliva" → debe preguntar el tamaño, nunca asumir uno
4. "quiero aceitunas" sin más detalle → debe ofrecer las categorías relevantes, no inventar una variante ni listar los 52 productos

## Estructura de carpetas esperada

```
bot-hilal/
├── CLAUDE.md              (este archivo)
├── data/
│   └── ProductosHilal_categorizado.xlsx
├── prisma/
│   └── schema.prisma       (tablas pedidos_en_curso y contactos)
├── src/
│   ├── whatsapp/            (webhook Meta Cloud API, envío/recepción, audio)
│   ├── chatwoot/             (módulo espejo, ver sección dedicada)
│   ├── catalog/              (carga y validación del excel)
│   ├── functions/            (definición de tools de function calling)
│   ├── session/              (acceso a pedidos_en_curso y contactos vía Prisma)
│   └── crm-client.ts          (único punto que le habla al CRM por HTTP)
└── package.json
```

## Preguntas abiertas (no asumir, confirmar con el usuario si surgen en el camino)

- Aliases reales de clientes para las categorías grandes (rellenas, calibre vidrio/PET) — pendiente de una conversación con el dueño de la fábrica.
