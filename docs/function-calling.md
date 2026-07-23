# Function calling (tools)

El bot usa [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling) para que el LLM ejecute acciones estructuradas sobre el carrito. Las tools se definen en `src/functions/tools.ts` y los handlers en `src/functions/handlers.ts`.

## Tools disponibles

| Tool | Descripción | Parámetros |
|---|---|---|
| `add_item` | Agregar producto al carrito | `product_id`, `variantes`, `cantidad` |
| `remove_item` | Quitar ítem del carrito | `line_id` |
| `update_quantity` | Cambiar cantidad (valor absoluto, no delta) | `line_id`, `nueva_cantidad` |
| `replace_item` | Reemplazar un ítem por otro producto | `line_id`, `product_id_nuevo`, `variantes` |
| `confirm_order` | Confirmar pedido y enviar al CRM | (sin parámetros) |
| `cancel_order` | Cancelar y limpiar el pedido | (sin parámetros) |
| `show_current_order` | Mostrar el pedido actual | (sin parámetros) |
| `repeat_last_order` | Cargar el último pedido como base | (sin parámetros) |
| `update_client_name` | Guardar nombre del cliente | `nombre`, `apellido?` |
| `update_delivery_info` | Registrar dirección/horario/notas | `direccion?`, `horario?`, `notas?` |

## Flujo de ejecución

```
OpenAI devuelve tool_calls
        │
        ▼
executeTool(telefono, name, args)
        │
        ▼
switch(name) → handler correspondiente
        │
        ▼
Handler:
  1. Valida inputs (producto existe, variante válida, etc.)
  2. Modifica la DB via session.ts
  3. Retorna { ok: true, message } o { ok: false, error }
        │
        ▼
El resultado se envía como mensaje "tool" a OpenAI
        │
        ▼
OpenAI genera la respuesta final para el cliente
```

## Validaciones

### add_item / replace_item
- Verifica que `product_id` exista en el catálogo
- Verifica que las variantes provistas sean válidas (`validateVariants`)
- Si `requires_specification=true` y falta el tamaño, devuelve error con opciones disponibles

### update_quantity
- Rechaza cantidades < 1 (para eliminar, usar `remove_item`)

### confirm_order
- Rechaza si el carrito está vacío
- Envía al CRM via `sendOrderToCRM()`
- Registra en `contactos` via `recordConfirmedOrder()`
- Limpia el historial de conversación

## Reglas del system prompt

El LLM tiene 11 reglas que guían cuándo y cómo usar las tools:

1. **Variantes** — No asumir defaults, preguntar el dato faltante
2. **Catálogo** — Nunca mostrar los 52 productos; acotar por categoría
3. **Carrito** — Mostrar pedido completo después de cada modificación
4. **Cantidades** — Valor absoluto, no delta; rechazar cantidades vagas
5. **Sin ambigüedad** — Actuar directo si no hay ambigüedad; si hay, preguntar primero
6. **Nombre** — Pedir una sola vez; siempre el de quien escribe
7. **Confirmación** — Solo confirmar con consentimiento explícito
8. **Precios** — Nunca dar precios; derivar al equipo comercial
9. **Fechas** — Nunca prometer fechas; derivar a logística
10. **Fuera de alcance** — Reclamos/quejas van al equipo humano
11. **Formato** — Sin markdown (asteriscos, #, backticks); texto plano
