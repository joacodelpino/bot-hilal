/**
 * Tests de la función transcribeAudio — todos usan mocks, no llaman APIs reales.
 */

import { transcribeAudio } from "../whatsapp/transcription.ts";

const FAKE_PHONE = "5491100000001";
const FAKE_MEDIA_ID = "media-abc-123";
const FAKE_BUFFER = Buffer.from("fake-ogg-content");
const FAKE_CONTENT_TYPE = "audio/ogg; codecs=opus";

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

// ─── Caso 1: descarga exitosa + transcripción OK ───────────────────────────────

async function caso1() {
  console.log("\nCASO 1: audio válido → transcripción OK, texto disponible");

  let downloadCalled = false;
  let transcribeCalled = false;

  const result = await transcribeAudio(FAKE_MEDIA_ID, FAKE_PHONE, {
    downloader: async (mediaId) => {
      downloadCalled = true;
      assert(mediaId === FAKE_MEDIA_ID, "downloader recibe el media_id correcto", `mediaId=${mediaId}`);
      return { buffer: FAKE_BUFFER, contentType: FAKE_CONTENT_TYPE };
    },
    transcriber: async (_file) => {
      transcribeCalled = true;
      return "quiero dos kilos de aceitunas verdes";
    },
  });

  assert(downloadCalled, "se intentó descargar el audio de Meta");
  assert(transcribeCalled, "se llamó a la API de transcripción");
  assert(result.ok === true, "resultado ok=true");
  if (result.ok) {
    assert(
      result.text === "quiero dos kilos de aceitunas verdes",
      "texto transcrito correcto",
      `text="${result.text}"`
    );
  }
}

// ─── Caso 2: texto transcrito entra al pipeline ────────────────────────────────

async function caso2() {
  console.log("\nCASO 2: transcripción devuelve texto → resultado contiene ese texto");

  const expectedText = "quiero aceite de oliva extra virgen de un litro";

  const result = await transcribeAudio(FAKE_MEDIA_ID, FAKE_PHONE, {
    downloader: async () => ({ buffer: FAKE_BUFFER, contentType: FAKE_CONTENT_TYPE }),
    transcriber: async () => expectedText,
  });

  assert(result.ok === true, "resultado ok=true");
  if (result.ok) {
    assert(
      result.text === expectedText,
      "el texto está disponible para pasar a processMessage",
      `text="${result.text}"`
    );
  }
}

// ─── Caso 3: descarga falla → reason=download_failed ──────────────────────────

async function caso3() {
  console.log("\nCASO 3: descarga de Meta falla → reason='download_failed'");

  let transcribeCalled = false;

  const result = await transcribeAudio(FAKE_MEDIA_ID, FAKE_PHONE, {
    downloader: async () => {
      throw new Error("Meta API 403 Forbidden");
    },
    transcriber: async () => {
      transcribeCalled = true;
      return "no debería llegar aquí";
    },
  });

  assert(result.ok === false, "resultado ok=false");
  if (!result.ok) {
    assert(result.reason === "download_failed", "reason='download_failed'", `reason=${result.reason}`);
  }
  assert(!transcribeCalled, "no se llamó a la API de transcripción (falla temprana)");
}

// ─── Caso 4: transcripción devuelve texto vacío → reason=empty ────────────────

async function caso4() {
  console.log("\nCASO 4: transcripción devuelve string vacío → reason='empty'");

  const result = await transcribeAudio(FAKE_MEDIA_ID, FAKE_PHONE, {
    downloader: async () => ({ buffer: FAKE_BUFFER, contentType: FAKE_CONTENT_TYPE }),
    transcriber: async () => "   ", // solo espacios — trim() → ""
  });

  assert(result.ok === false, "resultado ok=false");
  if (!result.ok) {
    assert(result.reason === "empty", "reason='empty'", `reason=${result.reason}`);
  }
}

// ─── Caso 5 (bonus): audio > 25MB → reason=too_long ──────────────────────────

async function caso5() {
  console.log("\nCASO 5: audio > 25 MB → reason='too_long'");

  const bigBuffer = Buffer.alloc(26 * 1024 * 1024); // 26 MB

  const result = await transcribeAudio(FAKE_MEDIA_ID, FAKE_PHONE, {
    downloader: async () => ({ buffer: bigBuffer, contentType: FAKE_CONTENT_TYPE }),
    transcriber: async () => {
      throw new Error("no debería llegar aquí");
    },
  });

  assert(result.ok === false, "resultado ok=false");
  if (!result.ok) {
    assert(result.reason === "too_long", "reason='too_long'", `reason=${result.reason}`);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

console.log("=== Tests de transcripción de audio ===");

await caso1();
await caso2();
await caso3();
await caso4();
await caso5();

console.log(`\n=== Fin: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
