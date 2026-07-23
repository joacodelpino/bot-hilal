# Edge cases y casos límite — Bot de pedidos WhatsApp Hilal

Este documento complementa los 4 casos de regresión ya definidos en `CLAUDE.md`. Antes de seguir sumando features nuevas, revisar y resolver lo que sigue, en el orden indicado (el punto 1 es el único que se trata como bug potencial, no como caso de producto a decidir).

## 1. Concurrencia de sesión (verificar primero — posible bug, no edge case de producto)

El workflow viejo de n8n tenía un buffer (`Wait_For_More_Messages`) para agrupar mensajes que llegan pegados del mismo teléfono. Confirmar si el bot nuevo porta esta lógica o algo equivalente.

Si dos mensajes del mismo teléfono llegan casi al mismo tiempo (típico cuando alguien dicta un pedido largo en varios mensajes cortos) y el backend los procesa en paralelo, puede darse una condición de carrera: ambos procesos leen el mismo estado de `pedidos_en_curso`, lo modifican por separado, y el segundo write pisa al primero sin fusionar los cambios.

**Acción**: confirmar si existe algún lock o cola de procesamiento por teléfono. Si no existe, es el primer bug a cerrar antes de seguir con el resto de este documento — un test manual no lo va a mostrar de forma confiable porque depende de timing. En caso de que no haya lock ni cola, explica primero que estrategia vas a usar y porque (advisory lock de Postgres, cola en memoria por teléfono, optimistic locking con versión en la fila, etc.)

## 2. Interpretación de lenguaje ambiguo

- Cantidades vagas: "una docena de aceitunas", "unas cuantas", "bastante aceite" — sin número exacto, el bot debe preguntar la cantidad puntual, nunca asumir un número.
- Referencias indirectas a algo ya mencionado: "el primero que dije", "ese mismo pero más grande", "como el pedido pasado pero sin las aceitunas" (interactúa con `repeat_last_order`).
- Typos y variantes de escritura: "azeitunas" vs "aseitunas", "aseite", "1lt", "medio kilo" (¿mapea a 500g?), "kg" vs "kilo" vs "kilogramo" vs "k".
- Negación + corrección en el mismo mensaje: "Al final no voy a querer las aceitunas, mejor cambialas por aceite" — debe resolverse como `remove` + `add` en un solo turno, no como una sola operación confusa.

## 3. Operaciones múltiples o encadenadas

- Dos acciones en un mensaje: "sacá las aceitunas y agregá 2 aceites de 1L" — si hay más de una variante de aceitunas en el carrito, el bot debe preguntar cuál sacar y de qué producto/cantidad antes de ejecutar el remove, y no perder de vista la segunda acción (el add) mientras resuelve la ambigüedad de la primera.
- Cambios de opinión en cadena dentro del mismo mensaje: "dame 3, no esperá, mejor 5, en realidad dejalo en 3" — el resultado final debe ser 3 (el último valor mencionado), no una suma ni el primer número.
- Pedido para otra persona: "es para mi vecina, ella se llama María" — el nombre capturado es **siempre** el de quien escribe (quien hace el pedido), nunca el del destinatario final. No confundir "nombre del pedido" con "nombre del contacto".

## 4. Ciclo de vida de la sesión

- **Pedido ya confirmado, cliente pide modificarlo igual**: "che, al pedido que ya mandé agregale 2 más". El diseño dice que una vez confirmado, el pedido ya fue enviado al CRM y pasa a intervención humana — el bot no debería tocarlo. Por eso el bot **siempre debe preguntar explícitamente antes de confirmar** si el cliente quiere modificar algo más. Si después de confirmado el cliente igual pide un cambio, el bot debe ofrecerle armar un **pedido nuevo**, no reabrir el ya confirmado. (Nota: este comportamiento todavía está en duda de cómo debe reaccionar exactamente el bot — no asumir una única solución sin confirmar el diseño final.)
- **Sesión abandonada a medias**: un cliente empieza un pedido, desaparece unos días, vuelve y escribe "hola". La sesión de `pedidos_en_curso` debe tener un **TTL** (tiempo de expiración). Si el cliente vuelve después de que el TTL se cumplió, el bot debe **preguntar** si quiere retomar el pedido anterior o empezar uno nuevo — no debe asumir ninguna de las dos opciones automáticamente.
- Cliente cancela y en el mismo mensaje arranca un pedido nuevo: "cancelá todo, mejor quiero 2 aceites" — debe procesarse como `cancel_order()` seguido de `add_item(...)` en el mismo turno, no quedarse solo con la cancelación.

## 5. Fuera del alcance que el bot puede responder (choca con la política)

- Precio: "¿cuánto sale el aceite de 5L?" — la política dice nunca confirmar precio. Verificar que el bot efectivamente deriva a la sucursal y no improvisa un número.
- Fecha de entrega: "¿me llega mañana?" — mismo caso, nunca prometer una fecha.
- Reclamos o quejas: "el pedido anterior llegó mal" — esto no es un pedido nuevo. Verificar si el bot lo reconoce como fuera de su función y deriva a un humano (vía Chatwoot), en vez de intentar procesarlo como una orden nueva.

## 6. Multi-canal (Chatwoot)

- Cliente escribe justo en el momento en que un agente se está asignando la conversación — ¿hay una ventana de carrera donde el bot y el humano podrían responder al mismo mensaje?
- Agente humano responde y luego se **desasigna** de la conversación (vuelve a "sin agente") — ¿el bot retoma automáticamente, o queda pausado hasta que alguien lo reactive a mano? Definir cuál de los dos comportamientos es el esperado.

## 7. Calidad de datos de entrada

- Audio con ruido de fondo o poco inteligible — si Whisper transcribe mal, ¿el bot pregunta "no te entendí bien, ¿podés repetirlo?" o interpreta la transcripción con errores como si fuera correcta?
- Mensajes multimedia no soportados: cliente manda una foto de un producto en vez de texto, o comparte una ubicación de GPS — el bot debe manejar esto sin romper el flujo (responder que no puede procesar ese tipo de contenido y pedir que lo describa en texto).

---

**Prioridad sugerida de trabajo**: resolver primero el punto 1 (concurrencia, posible bug silencioso), después el punto 5 (política de precios/fechas, más sensible de cara al cliente), y recién después los puntos 2, 3, 4, 6 y 7, que son mayormente de pulido y decisiones de producto a confirmar.
