import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el estado de la cola incluye su política vigente", () => {
  assert.match(logistics, /FROM logistics_outbox_slo_policies WHERE organization_id=\$1/);
  assert.match(logistics, /recentAttempts, policy/);
});

test("sólo administración actualiza límites validados", () => {
  assert.match(server, /\/api\/v1\/outbox\/policy/);
  assert.match(server, /Sólo administración puede configurar este objetivo/);
  for (const field of ["windowMinutes", "maxPendingMinutes", "maxFailureRatePercent",
    "minimumAttempts", "maxDeadLetters"]) assert.match(server, new RegExp(field));
  assert.match(server, /'OUTBOX_SLO_POLICY_UPDATED'/);
  assert.match(server, /evaluateOutboxDeliverySlo/);
});

test("configuración explica valores y permite editarlos", () => {
  assert.match(app, /data-edit-outbox-slo/);
  assert.match(app, /outboxSloPolicyModal/);
  assert.match(app, /outboxSloPolicyForm/);
  assert.match(app, /\/api\/v1\/outbox\/policy/);
  assert.match(app, /Recomendación inicial/);
});
