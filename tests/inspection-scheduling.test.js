import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/058_preventive_inspection_scheduling.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("cada equipo puede tener un plan preventivo versionado por eventos", () => {
  assert.match(migration, /logistics_asset_inspection_plans/);
  assert.match(migration, /UNIQUE \(organization_id,asset_unit_id\)/);
  assert.match(migration, /logistics_asset_inspection_plan_events/);
  assert.match(migration, /El historial del plan de inspección es inalterable/);
});

test("la periodicidad controla aviso gracia y bloqueo", () => {
  assert.match(migration, /interval_days INTEGER NOT NULL/);
  assert.match(migration, /warning_days INTEGER NOT NULL/);
  assert.match(migration, /grace_days INTEGER NOT NULL/);
  assert.match(migration, /block_on_overdue BOOLEAN NOT NULL/);
  assert.match(logistics, /reviewInspectionSchedules/);
  assert.match(logistics, /INSPECTION_DUE/);
});

test("el bloqueo se libera sólo sin otros impedimentos críticos", () => {
  assert.match(logistics, /logistics_work_orders/);
  assert.match(logistics, /logistics_asset_compliance_records/);
  assert.match(logistics, /status='BLOCKED'/);
  assert.match(logistics, /block_released_at=NOW\(\)/);
});

test("la agenda diaria ejecuta la revisión preventiva", () => {
  assert.match(migration, /INSPECTION_DAILY_REVIEW/);
  assert.match(logistics, /job\.job_code === "INSPECTION_DAILY_REVIEW"/);
  assert.match(server, /reviewInspectionSchedules/);
});

test("la interfaz administra planes desde Inspecciones", () => {
  assert.match(app, /Programación por equipo/);
  assert.match(app, /inspectionPlanForm/);
  assert.match(app, /\/api\/v1\/inspection-plans/);
  assert.match(app, /data-review-inspection-plans/);
});
