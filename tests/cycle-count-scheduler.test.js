import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/031_cycle_count_scheduler.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la agenda incorpora revisión diaria de conteos", () => {
  assert.match(migration, /CYCLE_COUNT_DAILY_REVIEW/);
  assert.match(migration, /America\/Santiago',9/);
  assert.match(migration, /ON CONFLICT \(organization_id,job_code\) DO NOTHING/);
});

test("la revisión usa stock físico, clasificación y último conteo por bodega", () => {
  assert.match(logistics, /export async function reviewCycleCountTasks/);
  assert.match(logistics, /location\.location_type='STORAGE'/);
  assert.match(logistics, /logistics_inventory_classifications/);
  assert.match(logistics, /last_counts\.warehouse_id=warehouse\.id/);
  assert.match(logistics, /recommended_count_interval_days\*INTERVAL '1 day'/);
});

test("no duplica programas cuando la bodega ya tiene conteo abierto", () => {
  assert.match(logistics, /NOT EXISTS/);
  assert.match(logistics, /open_count\.status IN \('DRAFT','IN_PROGRESS','SUBMITTED','APPROVED'\)/);
});

test("genera tareas por bodega y prioriza productos A", () => {
  assert.match(logistics, /task_type='CYCLE_COUNT_REVIEW'/);
  assert.match(logistics, /cycle-review-\$\{createHash/);
  assert.match(logistics, /item\.abc_class === "A"/);
  assert.match(logistics, /INSERT INTO inventory_notifications/);
  assert.match(logistics, /inventory_tasks\.status='En proceso'/);
});

test("el planificador sólo genera tareas y no modifica saldos", () => {
  const block = logistics.match(/export async function reviewCycleCountTasks[\s\S]*?export async function listCycleCounts/)?.[0] || "";
  assert.doesNotMatch(block, /postMovementWithClient/);
  assert.doesNotMatch(block, /UPDATE logistics_stock_balances/);
});

test("API e interfaz permiten revisar vencidos y muestran la agenda", () => {
  assert.match(server, /inventory-classifications\/review-counts/);
  assert.match(app, /data-review-cycle-counts/);
  assert.match(app, /Revisión automática de conteos/);
  assert.match(app, /Programa revisado/);
});
