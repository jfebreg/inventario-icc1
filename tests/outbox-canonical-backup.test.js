import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("el respaldo incluye configuración y evidencia de entrega", () => {
  for (const dataset of ["outboxEvents", "outboxDeliveryAttempts", "outboxSloPolicies",
    "automationSloPolicies", "scheduledJobEvents"]) {
    assert.match(server, new RegExp(`${dataset}:`));
  }
});

test("el paquete identifica esquema y contenido para recuperación", () => {
  assert.match(server, /SELECT version FROM logistics_schema_migrations/);
  assert.match(server, /schemaVersion,/);
  assert.match(server, /includedDatasets: Object\.keys\(datasets\)\.sort\(\)/);
  assert.match(server, /datasetCount: Object\.keys\(datasets\)\.length/);
});

test("el respaldo sigue excluyendo secretos y binarios de Storage", () => {
  assert.match(server, /filePayloadsExcluded: true/);
  assert.doesNotMatch(server, /datasets\.environmentVariables/);
  assert.doesNotMatch(server, /datasets\.webhookSecret/);
});
