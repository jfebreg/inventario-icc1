import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("las claves operativas tienen formato acotado y obligatorio", () => {
  assert.match(server, /function requireStableOperationKey/);
  assert.match(server, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(server, /INVALID_IDEMPOTENCY_KEY/);
  assert.match(server, /key\.length < 6 \|\| key\.length > 200/);
});

test("movimientos, devoluciones y etapas de traslado exigen idempotencia", () => {
  assert.match(server, /body\.idempotencyKey = requireStableOperationKey\(body\.idempotencyKey\)/);
  assert.ok((server.match(/body\.idempotencyKey = requireStableOperationKey\(body\.idempotencyKey\)/g) || []).length >= 3);
  assert.match(app, /idempotencyKey:`legacy-ui:\$\{legacyId\}:dispatch`/);
  assert.match(app, /idempotencyKey:`qr-receive:/);
  assert.match(app, /idempotencyKey:`ai-receipt:/);
});

test("creacion de traslados y custodia conserva referencias repetibles", () => {
  assert.match(server, /body\.transferNumber = requireStableOperationKey\(body\.transferNumber, "transferNumber"\)/);
  assert.match(server, /body\.externalReference = requireStableOperationKey\(body\.externalReference, "externalReference"\)/);
  assert.match(app, /transferNumber:`UI-\$\{legacyId\}`/);
  assert.match(app, /externalReference:`legacy-terrain:\$\{legacyId\}`/);
});
