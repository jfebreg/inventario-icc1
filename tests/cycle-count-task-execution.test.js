import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/032_cycle_count_task_execution.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el conteo conserva el vínculo único con su tarea programada", () => {
  assert.match(migration, /planned_task_id TEXT/);
  assert.match(migration, /REFERENCES inventory_tasks\(id\)/);
  assert.match(migration, /status<>'CANCELLED'/);
});

test("la tarea limita el conteo a sus productos vencidos", () => {
  assert.match(logistics, /task_type='CYCLE_COUNT_REVIEW' FOR UPDATE/);
  assert.match(logistics, /task\.payload\?\.dueItems/);
  assert.match(logistics, /balance\.item_id=ANY\(\$3::uuid\[\]\)/);
  assert.match(logistics, /La tarea no corresponde a la organización o bodega seleccionada/);
});

test("iniciar desde la tarea es idempotente y deja el trabajo en proceso", () => {
  assert.match(logistics, /task\.payload\?\.plannedCountId/);
  assert.match(logistics, /return \{ cycleCount: replay\.rows\[0\], replayed: true \}/);
  assert.match(logistics, /SET status='En proceso'/);
  assert.match(logistics, /'plannedCountId'/);
});

test("cancelar reactiva la tarea y contabilizarla la resuelve", () => {
  assert.match(logistics, /SET status='Pendiente',resolved_at=NULL/);
  assert.match(logistics, /'lastCancelledCountId'/);
  assert.match(logistics, /SET status='Resuelta',resolved_at=NOW\(\)/);
  assert.match(logistics, /'adjustedLines'/);
});

test("la tarea no puede cerrarse manualmente", () => {
  assert.match(server, /task_type === "CYCLE_COUNT_REVIEW"/);
  assert.match(server, /se resolverá automáticamente al contabilizar el conteo físico/);
});

test("la bandeja abre o inicia el conteo programado", () => {
  assert.match(app, /data-cycle-task/);
  assert.match(app, /function openCycleCountTask/);
  assert.match(app, /Abrir conteo/);
  assert.match(app, /Iniciar conteo/);
});
