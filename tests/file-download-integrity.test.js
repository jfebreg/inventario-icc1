import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("cada descarga recalcula tamaño y SHA-256", () => {
  assert.match(server, /async function verifyFileIntegrity/);
  assert.match(server, /createHash\("sha256"\)\.update\(body\)\.digest\("hex"\)/);
  assert.match(server, /expectedSize !== body\.length/);
  assert.match(server, /safeTokenEqual\(actualSha256, expectedSha256\)/);
  assert.ok((server.match(/await verifyFileIntegrity\(row, body, apiProfile\)/g) || []).length >= 2);
});

test("un archivo alterado se bloquea y deja auditoría", () => {
  assert.match(server, /FILE_SIZE_MISMATCH/);
  assert.match(server, /FILE_INTEGRITY_MISMATCH/);
  assert.match(server, /file_integrity_failure/);
  assert.match(server, /Integridad de archivo fallida/);
  assert.match(server, /descarga fue bloqueada/);
});

test("una descarga válida informa su huella verificable", () => {
  assert.match(server, /function fileIntegrityHeaders/);
  assert.match(server, /"X-Content-SHA256"/);
  assert.match(server, /"X-Integrity-Status"/);
  assert.match(server, /"Content-Digest"/);
  assert.match(server, /sha-256=:/);
});
