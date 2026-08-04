import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const guide = await readFile(new URL("../GUIA_PUBLICACION.md", import.meta.url), "utf8");

test("las conexiones externas siempre tienen un plazo máximo", () => {
  assert.match(server, /async function fetchWithTimeout/);
  assert.match(server, /new AbortController\(\)/);
  assert.match(server, /controller\.abort\(\)/);
  assert.match(server, /clearTimeout\(timer\)/);
  assert.equal((server.match(/await fetch\(/g) || []).length, 1, "sólo el envoltorio controlado puede invocar fetch directamente");
});

test("una caída externa se informa sin revelar detalles técnicos", () => {
  assert.match(server, /UPSTREAM_TIMEOUT/);
  assert.match(server, /UPSTREAM_UNAVAILABLE/);
  assert.match(server, /no respondió dentro del plazo permitido/);
  assert.match(server, /no está disponible temporalmente/);
});

test("OpenAI y Storage usan plazos separados y ajustables", () => {
  assert.match(server, /OPENAI_TIMEOUT_MS \|\| 90_000/);
  assert.match(server, /STORAGE_TIMEOUT_MS \|\| 30_000/);
  assert.match(server, /service: "OpenAI"/);
  assert.match(server, /service: "Supabase Storage"/);
  assert.match(guide, /OPENAI_TIMEOUT_MS/);
  assert.match(guide, /STORAGE_TIMEOUT_MS/);
});
