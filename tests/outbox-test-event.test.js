import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("sólo administración puede crear la prueba controlada", () => {
  assert.match(server, /\/api\/v1\/outbox\/test/);
  assert.match(server, /Sólo administración puede enviar eventos de prueba/);
  assert.match(server, /profileCan\(apiProfile, "admin"\)/);
});

test("el evento de prueba es idempotente auditable y no simula una falla", () => {
  assert.match(server, /'system\.delivery\.test'/);
  assert.match(server, /`manual-test:\$\{testReference\}`/);
  assert.match(server, /'OUTBOX_TEST_CREATED'/);
  assert.match(server, /purpose: "DELIVERY_VERIFICATION"/);
  assert.doesNotMatch(server, /'system\.delivery\.test'[\s\S]{0,400}'SCHEDULER_FAILURE'/);
});

test("la interfaz confirma ejecuta y actualiza la bitácora", () => {
  assert.match(app, /data-test-outbox/);
  assert.match(app, /evento técnico sin datos de inventario/);
  assert.match(app, /\/api\/v1\/outbox\/test/);
  assert.match(app, /Evento de prueba enviado\. Revisa la bitácora/);
});
