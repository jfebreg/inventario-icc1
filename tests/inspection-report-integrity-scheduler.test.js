import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/064_inspection_report_integrity_scheduler.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la agenda crea una revisión semanal específica en lotes acotados", () => {
  assert.match(migration, /INSPECTION_REPORT_WEEKLY_VERIFICATION/);
  assert.match(migration, /schedule_interval_days,batch_limit/);
  assert.match(migration, /'America\/Santiago',4,90,7,25/);
});

test("la ejecución manual y automática comparten un bloqueo distribuido", () => {
  assert.match(server, /async function runCanonicalReportVerificationWithLock/);
  assert.match(server, /icc:inspection-report-integrity/);
  assert.match(server, /REPORT_VERIFICATION_RUNNING/);
  assert.match(server, /job\.job_code === "INSPECTION_REPORT_WEEKLY_VERIFICATION"/);
});

test("el planificador genérico no reclama ninguna verificación especializada", () => {
  assert.match(logistics, /job_code NOT IN \('EVIDENCE_WEEKLY_VERIFICATION',\s*'INSPECTION_REPORT_WEEKLY_VERIFICATION'\)/);
});

test("Configuración muestra próxima ejecución y fallas del trabajo", () => {
  assert.match(server, /job_code='INSPECTION_REPORT_WEEKLY_VERIFICATION'/);
  assert.match(app, /Revisión automática semanal/);
  assert.match(app, /schedule\.next_run_at/);
  assert.match(app, /schedule\?\.last_status==='FAILED'/);
});
