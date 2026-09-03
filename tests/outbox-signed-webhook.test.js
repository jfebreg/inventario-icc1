import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("el canal externo exige HTTPS y secreto fuera del código", () => {
  assert.match(server, /OUTBOX_WEBHOOK_URL/);
  assert.match(server, /OUTBOX_WEBHOOK_SECRET/);
  assert.match(server, /parsed\.protocol === "https:"/);
  assert.match(server, /createHmac\("sha256", settings\.secret\)/);
});

test("la solicitud permite verificar firma tiempo e idempotencia", () => {
  assert.match(server, /X-ICC-Event-Id/);
  assert.match(server, /X-ICC-Timestamp/);
  assert.match(server, /X-ICC-Signature/);
  assert.match(server, /Idempotency-Key/);
  assert.match(server, /timeoutMs: process\.env\.OUTBOX_WEBHOOK_TIMEOUT_MS/);
});

test("cada destino se audita y todos deben terminar antes de publicar", () => {
  assert.match(logistics, /externalTargets/);
  assert.match(logistics, /for \(const target of targets\)/);
  assert.match(logistics, /await target\.deliver\(envelope, event\)/);
  assert.match(logistics, /text\(target\.channel\)/);
  assert.match(logistics, /text\(target\.destination\)/);
});

test("la preparación productiva detecta configuración parcial", () => {
  assert.match(server, /outboxWebhook/);
  assert.match(server, /webhookPartiallyConfigured/);
  assert.match(server, /Canal opcional desactivado/);
});
