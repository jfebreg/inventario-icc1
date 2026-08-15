import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/057_inspection_review_workflow.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("la inspección conserva revisor, plazo y estado normalizados", () => {
  assert.match(migration, /assigned_reviewer_profile_id TEXT REFERENCES inventory_user_profiles/);
  assert.match(migration, /review_due_at TIMESTAMPTZ/);
  assert.match(migration, /WAITING_CORRECTION/);
  assert.match(migration, /logistics_inspection_review_due_idx/);
});

test("el envío crea tarea de revisión vinculada al revisor y centro", () => {
  assert.match(logistics, /inspection-review-\$\{inspection\.id\}/);
  assert.match(logistics, /taskType: "INSPECTION_REVIEW"/);
  assert.match(logistics, /recipientAuthUserId: reviewer\?\.auth_user_id/);
  assert.match(logistics, /reviewDueAt/);
});

test("corrección y verificación avanzan y resuelven sus tareas", () => {
  assert.match(logistics, /taskType: "INSPECTION_CORRECTION"/);
  assert.match(logistics, /taskType: "INSPECTION_VERIFICATION"/);
  assert.match(logistics, /review_status='WAITING_CORRECTION'/);
  assert.match(logistics, /review_status='COMPLETED'/);
  assert.match(logistics, /resolveInspectionTask/);
});

test("el barrido periódico escala vencimientos una sola vez", () => {
  assert.match(logistics, /reviewInspectionWorkflowTasks/);
  assert.match(logistics, /inspection-review-sla:/);
  assert.match(logistics, /INSPECTION_SLA_ESCALATED/);
  assert.match(logistics, /NOT \(task\.payload \? 'escalatedAt'\)/);
  assert.match(server, /reviewInspectionWorkflowTasks\(pool, logisticsOrganizationId\)/);
});
