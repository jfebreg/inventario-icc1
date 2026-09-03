import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/065_scheduled_job_execution_history.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el historial de automatizaciones es append-only y protegido", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_scheduled_job_events/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON logistics_scheduled_job_events/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON logistics_scheduled_job_events FROM anon,authenticated/);
});

test("cada ejecución conserva inicio y un único resultado terminal", () => {
  assert.match(migration, /UNIQUE \(execution_id,event_type\)/);
  assert.match(migration, /logistics_scheduled_job_events_terminal_uq/);
  assert.match(server, /'STARTED','\{\}'::jsonb/);
  assert.match(server, /'SUCCESS',\$5,\$6,\$7::jsonb/);
  assert.match(server, /'FAILED',\$5,'\{\}'::jsonb,\$6/);
  assert.match(server, /Date\.now\(\) - executionStartedAt/);
});

test("la custodia expone sólo resultados terminales recientes", () => {
  assert.match(server, /event_type IN \('SUCCESS','FAILED'\)/);
  assert.match(server, /ORDER BY occurred_at DESC LIMIT 10/);
  assert.match(server, /recent, integrity, schedule, executions/);
  assert.match(app, /Historial de ejecuciones automáticas/);
});
