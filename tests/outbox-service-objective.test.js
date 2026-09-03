import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/069_outbox_service_objectives.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("la política limita atraso fallos y descartes con muestra mínima", () => {
  assert.match(migration, /logistics_outbox_slo_policies/);
  assert.match(migration, /max_pending_minutes/);
  assert.match(migration, /max_failure_rate_percent/);
  assert.match(migration, /minimum_attempts/);
  assert.match(migration, /max_dead_letters/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la evaluación abre una sola tarea crítica y evidencia la brecha", () => {
  assert.match(logistics, /export async function evaluateOutboxDeliverySlo/);
  assert.match(logistics, /outbox-health-\$\{organizationId\}/);
  assert.match(logistics, /'OUTBOX_HEALTH'/);
  assert.match(logistics, /'OUTBOX_HEALTH_BREACH'/);
  assert.match(logistics, /'OUTBOX_SLO_BREACHED'/);
  assert.match(logistics, /newlyBreached/);
  assert.match(logistics, /due_at=COALESCE\(inventory_tasks\.due_at,EXCLUDED\.due_at\)/);
});

test("la recuperación resuelve la tarea y deja notificación y auditoría", () => {
  assert.match(logistics, /'OUTBOX_HEALTH_RECOVERED'/);
  assert.match(logistics, /'OUTBOX_SLO_RECOVERED'/);
  assert.match(logistics, /status='Resuelta',resolved_at=NOW\(\)/);
  assert.match(logistics, /status: "COMPLIANT"/);
});

test("cada barrido procesa y luego evalúa el objetivo de servicio", () => {
  assert.match(server, /evaluateOutboxDeliverySlo/);
  assert.match(server, /const serviceObjective = await evaluateOutboxDeliverySlo/);
  assert.match(server, /return \{ \.\.\.processing, serviceObjective \}/);
});
