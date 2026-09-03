import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el diagnóstico cubre dependencias críticas de producción", () => {
  assert.match(server, /async function productionReadiness/);
  for (const check of ["database", "migrations", "auth", "storage", "audit",
    "backup", "documents", "rls", "criticalTasks", "openai", "scheduler", "evidenceAutomation", "inspectionReportAutomation", "inspectionReportSlo", "outbox", "outboxWebhook", "cutover", "accessReview"]) {
    assert.match(server, new RegExp(`"${check}"`));
  }
});

test("distingue bloqueos, advertencias y ambiente listo", () => {
  assert.match(server, /"NOT_READY"/);
  assert.match(server, /"DEGRADED"/);
  assert.match(server, /"READY"/);
  assert.match(server, /checks\.some\(check => check\.status === "FAIL"\)/);
});

test("verifica migración, RLS, auditoría y antigüedad del respaldo", () => {
  assert.match(server, /latestMigration\.startsWith\("069_"\)/);
  assert.match(server, /logistics_audit_chain_verification/);
  assert.match(server, /relation\.relrowsecurity/);
  assert.match(server, /backupAge > 7/);
});

test("el diagnóstico está restringido a administración", () => {
  assert.match(server, /\/api\/admin\/readiness/);
  assert.match(server, /Sólo el administrador puede revisar la preparación productiva/);
});

test("la interfaz muestra resultados y acciones correctivas", () => {
  assert.match(app, /function renderProductionReadinessCard/);
  assert.match(app, /data-run-readiness/);
  assert.match(app, /Preparación productiva/);
  assert.match(app, /Acción necesaria/);
});

test("la preparación productiva detecta una agenda de informes ausente detenida atrasada o fallida", () => {
  assert.match(server, /job_code='INSPECTION_REPORT_WEEKLY_VERIFICATION'/);
  assert.match(server, /inspectionReportOverdue/);
  assert.match(server, /inspectionReportSchedule\.last_status === "FAILED"/);
  assert.match(server, /Integridad automática de informes finales/);
  assert.match(server, /La verificación automática está detenida/);
});
