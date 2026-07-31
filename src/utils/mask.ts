/**
 * Enmascara un número de teléfono para logs — preserva prefijo de país/área
 * y últimos 4 dígitos.
 * "+5493835123456" → "+54938****3456"
 * "5491100000001"  → "549110****0001"
 */
export function maskPhone(telefono: string): string {
  const s = String(telefono);
  if (s.length <= 8) return "****"; // demasiado corto para enmascarar parcialmente
  const prefix = s.slice(0, Math.min(6, s.length - 4));
  const suffix = s.slice(-4);
  return `${prefix}****${suffix}`;
}
