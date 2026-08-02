# Comandos del agente — V2

Reemplaza a `function-calling.md` de V1. Las tools que el LLM llamaba directamente ahora son comandos que el **agente humano** ejecuta desde Chatwoot.

## Cómo se usan

En Chatwoot hay un toggle arriba del campo donde el agente escribe. Define a quién le está hablando:

| Toggle | Va a | Se usa para |
|---|---|---|
| **Reply** / Responder | El cliente, por WhatsApp | Atender al cliente |
| **Private Note** / Nota privada | Solo Chatwoot (interno) | Hablarle al bot y anotaciones del equipo |

Los comandos van siempre en **Private Note**. El bot los detecta vía webhook, los ejecuta y responde con otra nota privada.

**Riesgo a tener en cuenta en el onboarding**: si el agente se olvida de cambiar el toggle, el comando le llega al cliente por WhatsApp. No es grave (el cliente ve un mensaje raro, el pedido simplemente no se envía y se reintenta), pero es el error más probable al principio. Vale la pena mostrarlo explícitamente en la sesión de capacitación.

## Comandos disponibles

| Comando | Ejemplo | Qué hace |
|---|---|---|
| `/pedido` | `/pedido` | Muestra el carrito sugerido actual |
| `/agregar <texto>` | `/agregar 3 aceitunas verdes calibre 0 de 500g` | Agrega un producto. El bot resuelve el `product_id` y las variantes |
| `/quitar <n>` | `/quitar 2` | Quita la línea número 2 del carrito |
| `/cantidad <n> <cant>` | `/cantidad 1 5` | La línea 1 pasa a cantidad 5 (valor final, no suma) |
| `/nombre <nombre>` | `/nombre Martín Gómez` | Registra el nombre del cliente |
| `/repetir` | `/repetir` | Carga el último pedido confirmado como base |
| `/limpiar` | `/limpiar` | Vacía el carrito sugerido |
| `/enviar_pedido` | `/enviar_pedido` | Valida y envía el pedido al CRM |
| `/ayuda` | `/ayuda` | Lista todos los comandos |

## Detalles de implementación

### Parsing

Determinístico, con regex. No pasa por el LLM.

```
/^\/(\w+)(?:\s+(.*))?$/
```

Si el comando no matchea ninguno conocido → nota privada con el mensaje de `/ayuda`.

### `/agregar` — el único que usa LLM

Recibe texto libre y tiene que resolverlo a `product_id` + variantes. Usa el mismo extractor de intención que el análisis automático de mensajes.

**Comportamiento ante ambigüedad:** si el texto no resuelve un producto único o faltan variantes requeridas, NO agrega nada. Devuelve una nota privada con las opciones:

```
⚠ "aceitunas verdes en vidrio" es ambiguo:
  - Aceitunas (vidrio) verdes 0   (calibre grande)
  - Aceitunas (vidrio) verdes 00  (calibre gigante)

Ambos requieren tamaño: 200g, 500g, 1kg, 2kg

Ejemplo: /agregar 2 aceitunas verdes 0 de 500g
```

### `/cantidad` — valor final, no delta

Heredado de la decisión de V1. `/cantidad 1 5` deja la línea 1 en 5 unidades, no le suma 5. Esto se documenta explícitamente porque era una fuente de bugs en el bot viejo de n8n.

### `/enviar_pedido` — validaciones

Antes de hacer el POST al CRM:

1. **Carrito no vacío** — si está vacío, error: "El pedido está vacío. Agregá productos antes de enviar."
2. **Validación Zod `.strict()`** — el payload `ConfirmedOrder` no acepta campos extra (bloquea que se cuele un precio, que el bot tiene prohibido manejar)
3. **Nombre del cliente** — si falta, advertencia pero no bloqueo (el agente decide si enviarlo igual)

Si el POST falla, la nota privada muestra el error con detalle para que el agente sepa si reintentar o avisar al dueño.

Después de un envío exitoso:
- `estado` pasa a `"confirmado"`
- Se registra en `contactos` (incrementa `cantidad_pedidos_confirmados`, guarda `ultimo_pedido_items`)

## Migración desde V1

| V1 (tool del LLM) | V2 (comando del agente) | Nota |
|---|---|---|
| `add_item` | `/agregar` | Ahora con texto libre en vez de `product_id` |
| `remove_item` | `/quitar` | Por número de línea, no por `line_id` |
| `update_quantity` | `/cantidad` | Igual, valor absoluto |
| `replace_item` | `/quitar` + `/agregar` | Se elimina como operación única |
| `confirm_order` | `/enviar_pedido` | Nombre más claro para el agente |
| `cancel_order` | `/limpiar` | |
| `show_current_order` | `/pedido` | |
| `repeat_last_order` | `/repetir` | |
| `update_client_name` | `/nombre` | |
| `update_delivery_info` | — | Pendiente de decidir si se necesita |
| `escalate_to_human` | — | **Eliminado.** El humano siempre está a cargo |
| `show_catalog` | — | **Eliminado.** El bot lo sugiere en las notas automáticamente |

## Por qué comandos y no lenguaje natural

El agente podría escribir "agregale 3 aceitunas" y dejar que el LLM lo interprete. No se hace por dos razones:

1. **Determinismo** — `/quitar 2` siempre quita la línea 2. "sacá las aceitunas" depende de que el LLM elija bien.
2. **Separación clara** — los comandos empiezan con `/`, así el bot nunca confunde una nota privada normal del agente (ej. "el cliente parece apurado") con una instrucción.

El lenguaje natural queda para donde aporta valor real: interpretar lo que escribe **el cliente**, no lo que escribe el agente.

## Nota sobre el alcance

Estos 9 comandos asumen un equipo con rotación, que no conoce el catálogo de memoria y necesita apoyo del bot para armar el pedido.

**Si el equipo de Hilal resulta ser experto** (empleados con años en la empresa que se saben los 52 productos), la mayoría de estos comandos sobran: el agente arma el pedido más rápido a mano que escribiendo `/agregar`. En ese escenario, el set se reduce a lo que aporta valor incluso a un experto:

- `/enviar_pedido` — le ahorra tipear el pedido completo en el CRM
- `/pedido` — para revisar antes de enviar
- `/repetir` — nadie recuerda de memoria qué pidió un cliente hace dos semanas

Los otros 6 se eliminan y el bot pasa a inferir el carrito solo de la conversación.

**Decisión tomada**: se construye el set completo asumiendo rotación, y se poda si el perfil del equipo lo justifica. Podar es más barato que agregar features sobre algo ya en producción.
