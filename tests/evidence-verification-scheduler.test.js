import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/051_evidence_verification_scheduler.sql", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("la agenda semanal define intervalo, lote y zona horaria", () => {
  assert.match(migration, /EVIDENCE_WEEKLY_VERIFICATION/);
  assert.match(migration, /schedule_interval_days/);
  assert.match(migration, /batch_limit/);
  assert.match(migration, /America\/Santiago/);
});

test("el ejecutor usa bloqueo distribuido y reintento ante caída", () => {
  assert.match(server, /async function runDueEvidenceVerificationJobs/);
  assert.match(server, /pg_try_advisory_lock/);
  assert.match(server, /icc:evidence-verification-scheduler/);
  assert.match(server, /INTERVAL '30 minutes'/);
  assert.match(server, /INTERVAL '4 hours'/);
});

test("el planificador genérico no reclama el trabajo especializado", () => {
  assert.match(logistics, /job_code NOT IN \('EVIDENCE_WEEKLY_VERIFICATION',\s*'INSPECTION_REPORT_WEEKLY_VERIFICATION'\)/);
  assert.match(server, /const evidence = await runDueEvidenceVerificationJobs/);
  assert.match(server, /const logistics = await runDueLogisticsJobs/);
});

test("una falla automática crea tarea y notificación críticas", () => {
  assert.match(server, /Falló la verificación automática de evidencias/);
  assert.match(server, /notification-scheduler-/);
  assert.match(server, /'SCHEDULER_FAILURE'/);
  assert.match(server, /"evidenceAutomation"/);
});
