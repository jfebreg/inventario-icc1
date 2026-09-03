import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8");

test("las fallas tienen plazo antes de escalar", () => {
  assert.match(server, /NOW\(\)\+INTERVAL '2 hours'/);
  assert.match(server, /NOW\(\)\+INTERVAL '30 minutes'/);
  assert.match(architecture, /plazo operativo de dos horas/);
});

test("el escalamiento reclama atómicamente sólo tareas vencidas", () => {
  assert.match(server, /async function escalateOverdueSchedulerFailures/);
  assert.match(server, /task_type='SCHEDULER_FAILURE'/);
  assert.match(server, /due_at<=NOW\(\)/);
  assert.match(server, /payload->>'escalatedAt'/);
  assert.match(server, /'SCHEDULER_ESCALATION'/);
});

test("una ejecución correcta cierra la tarea y las alertas anteriores", () => {
  assert.match(server, /RETURNING id,title/);
  assert.match(server, /entity_type='scheduled_job' AND entity_id=\$1 AND read_at IS NULL/);
  assert.match(server, /'SCHEDULER_RECOVERED'/);
  assert.match(server, /Automatización recuperada correctamente/);
});

test("el barrido informa cuántas tareas fueron escaladas", () => {
  assert.match(server, /const escalations = await escalateOverdueSchedulerFailures\(\)/);
  assert.match(server, /escalations: escalations\.length/);
});
