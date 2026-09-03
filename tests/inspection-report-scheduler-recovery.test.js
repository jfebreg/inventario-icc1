import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8");

test("el recuperador identifica inicios sin resultado terminal", () => {
  assert.match(server, /async function recoverInterruptedVerificationRuns/);
  assert.match(server, /started\.event_type='STARTED' AND terminal\.id IS NULL/);
  assert.match(server, /INTERVAL '30 minutes'/);
});

test("una caída agrega un cierre fallido sin alterar el inicio", () => {
  assert.match(server, /'FAILED'[\s\S]*jsonb_build_object\('recovered',TRUE\)/);
  assert.match(server, /Ejecución interrumpida por reinicio o pérdida del proceso/);
  assert.match(server, /ON CONFLICT DO NOTHING/);
});

test("el trabajo se reactiva y escala a tarea y notificación críticas", () => {
  assert.match(server, /last_result=\$3::jsonb,next_run_at=NOW\(\)/);
  assert.match(server, /'SCHEDULER_INTERRUPTED'/);
  assert.match(server, /notification-scheduler-interrupted-/);
  assert.match(server, /recovered: recovered\.length/);
});

test("la arquitectura documenta la recuperación posterior a un reinicio", () => {
  assert.match(architecture, /Render se reinicia/);
  assert.match(architecture, /treinta minutos/);
  assert.match(architecture, /reintento inmediato/);
});
