import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/059_inspection_plan_execution_integrity.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("cada plan define el formulario que puede satisfacerlo", () => {
  assert.match(migration, /required_template_key TEXT/);
  assert.match(migration, /ALTER COLUMN required_template_key SET NOT NULL/);
  assert.match(logistics, /requiredTemplateKey/);
});

test("la ejecución queda vinculada formalmente al plan", () => {
  assert.match(migration, /inspection_plan_id UUID/);
  assert.match(migration, /logistics_inspection_runs_plan_completed_idx/);
  assert.match(logistics, /inspectionPlan\?\.id/);
});

test("PostgreSQL rechaza equipo o formulario incorrectos", () => {
  assert.match(migration, /logistics_validate_inspection_plan_execution/);
  assert.match(migration, /no corresponde al equipo del plan preventivo/);
  assert.match(migration, /formulario no corresponde al exigido/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF inspection_plan_id,template_version_id,asset_unit_id/);
});

test("sólo una ejecución vinculada actualiza la próxima fecha", () => {
  assert.match(logistics, /inspection\.inspection_plan_id=plan\.id/);
  assert.match(logistics, /inspection\.status IN \('APPROVED','CLOSED'\)/);
});

test("aprobar o verificar recalcula el plan inmediatamente", () => {
  assert.match(server, /\["approve", "verify"\]\.includes\(operation\)/);
  assert.match(server, /reviewInspectionSchedules\(pool, logisticsOrganizationId\)/);
});
