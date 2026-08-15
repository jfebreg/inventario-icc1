import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/056_immutable_inspection_evidence.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("respuestas y decisiones de inspección son inalterables", () => {
  assert.match(migration, /logistics_inspection_answers_no_change/);
  assert.match(migration, /logistics_inspection_approvals_no_change/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON logistics_inspection_answers/);
});

test("las plantillas utilizadas sólo cambian mediante una nueva versión", () => {
  assert.match(migration, /logistics_guard_inspection_template_version/);
  assert.match(migration, /debe crearse una nueva versión/);
  assert.match(migration, /logistics_inspection_template_items_no_change/);
});

test("la identidad y resultado original del registro quedan protegidos", () => {
  assert.match(migration, /logistics_guard_inspection_run_evidence/);
  assert.match(migration, /Los datos originales de la inspección enviada son inalterables/);
  assert.match(migration, /approver_profile_id/);
});

test("cada transición de hallazgo conserva antes, después y responsable", () => {
  assert.match(migration, /logistics_inspection_finding_events/);
  assert.match(migration, /before_state JSONB NOT NULL/);
  assert.match(migration, /after_state JSONB NOT NULL/);
  assert.match(logistics, /recordFindingTransitions/);
  assert.match(logistics, /MAINTENANCE_CORRECTION/);
});
