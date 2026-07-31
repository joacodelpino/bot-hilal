/**
 * Tests de verifyMetaSignature — sin dependencias externas, sin env vars reales.
 */

import { createHmac } from "crypto";
import { verifyMetaSignature } from "../whatsapp/webhook.ts";

const SECRET = "test-app-secret-hilal";
const BODY = JSON.stringify({ entry: [{ id: "1", changes: [] }] });
const RAW = Buffer.from(BODY).buffer as ArrayBuffer;

function makeSignature(body: ArrayBuffer, secret: string): string {
  const hex = createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
  return `sha256=${hex}`;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ PASS  ${label}${detail ? `\n         ${detail}` : ""}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL  ${label}${detail ? `\n         ${detail}` : ""}`);
    failed++;
  }
}

console.log("=== Tests de verificación de firma Meta webhook ===\n");

// Setear el secret en el env para los tests
process.env.META_APP_SECRET = SECRET;

// ─── Caso 1: firma válida → true ─────────────────────────────────────────────
console.log("CASO 1: firma válida → debe retornar true");
{
  const sig = makeSignature(RAW, SECRET);
  const result = verifyMetaSignature(RAW, sig);
  assert(result === true, "firma válida aceptada", `signature=${sig.slice(0, 20)}...`);
}

// ─── Caso 2: firma inválida → false ──────────────────────────────────────────
console.log("\nCASO 2: firma inválida → debe retornar false");
{
  const badSig = "sha256=" + "a".repeat(64);
  const result = verifyMetaSignature(RAW, badSig);
  assert(result === false, "firma incorrecta rechazada");
}

// ─── Caso 3: sin header → false ──────────────────────────────────────────────
console.log("\nCASO 3: sin header (null) → debe retornar false");
{
  const result = verifyMetaSignature(RAW, null);
  assert(result === false, "firma ausente rechazada");
}

// ─── Caso 4: firma con secret incorrecto → false ──────────────────────────────
console.log("\nCASO 4: firma con otro secret → debe retornar false");
{
  const sigWrongSecret = makeSignature(RAW, "otro-secret");
  const result = verifyMetaSignature(RAW, sigWrongSecret);
  assert(result === false, "firma con secret incorrecto rechazada");
}

// ─── Caso 5: body diferente, firma original → false ──────────────────────────
console.log("\nCASO 5: body modificado, firma original → debe retornar false");
{
  const validSig = makeSignature(RAW, SECRET);
  const tamperedBody = Buffer.from(BODY + " ").buffer as ArrayBuffer;
  const result = verifyMetaSignature(tamperedBody, validSig);
  assert(result === false, "body tampered con firma original rechazado");
}

// ─── Caso 6: sin META_APP_SECRET → false ─────────────────────────────────────
console.log("\nCASO 6: sin META_APP_SECRET → debe retornar false");
{
  const sig = makeSignature(RAW, SECRET);
  const savedSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;
  const result = verifyMetaSignature(RAW, sig);
  process.env.META_APP_SECRET = savedSecret; // restaurar
  assert(result === false, "sin secret configurado, rechaza todo");
}

console.log(`\n=== Fin: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
