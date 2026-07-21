// ─── Catálogo ─────────────────────────────────────────────────────────────────

export interface CatalogProduct {
  product_id: string;
  product_name: string;
  variant_options: string[]; // valores válidos, ej: ["200g", "500g", "1kg"]
  requires_specification: boolean;
  category: string;
  aliases: string[];
}

// ─── Carrito ──────────────────────────────────────────────────────────────────

export interface CartItem {
  line_id: string;       // UUID único dentro de la sesión
  product_id: string;
  variantes: Record<string, string>; // ej: { tamaño: "500g" }
  cantidad: number;
}

// ─── Sesión (pedidos_en_curso) ────────────────────────────────────────────────

export type OrderStatus = "iniciado" | "armando_pedido" | "confirmado";

export interface Session {
  telefono_cliente: string;
  estado: OrderStatus;
  items: CartItem[];
  historial: any[];
  nombre: string | null;
  apellido: string | null;
  direccion: string | null;
  horario: string | null;
  notas: string | null;
  ultima_actualizacion: Date;
}

// ─── Contactos ────────────────────────────────────────────────────────────────

export interface Contact {
  telefono: string;
  nombre_apellido: string | null;
  primera_vez: Date;
  ultima_interaccion: Date;
  cantidad_pedidos_confirmados: number;
  ultimo_pedido_items: CartItem[] | null;
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────

export type MessageType = "text" | "audio" | "image" | "document";

export interface IncomingMessage {
  from: string;      // número en formato E.164 sin "+"
  messageId: string;
  type: MessageType;
  text?: string;
  mediaId?: string;
  timestamp: string;
}

// ─── Chatwoot ────────────────────────────────────────────────────────────────

export interface ChatwootResult {
  bot_paused: boolean;
  conv_id: string;
}

// ─── CRM ─────────────────────────────────────────────────────────────────────

export interface ConfirmedOrder {
  telefono_cliente: string;
  nombre_apellido: string | null;
  items: CartItem[];
  direccion: string | null;
  horario: string | null;
  notas: string | null;
  confirmed_at: string; // ISO 8601
}
