import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,server,app]=await Promise.all([
  readFile(new URL("../migrations/075_backup_recovery_weekly_test.sql",import.meta.url),"utf8"),
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8")
]);

test("la agenda semanal prueba el respaldo archivado más reciente",()=>{
  assert.match(migration,/BACKUP_RECOVERY_WEEKLY_TEST/);
  assert.match(migration,/period_days,next_run_at/);
  assert.match(migration,/TRUE,'America\/Santiago',5,7/);
  assert.match(server,/job_code IN \('BACKUP_RPO_DAILY_CHECK','BACKUP_RECOVERY_WEEKLY_TEST'\)/);
});

test("la prueba recupera Storage valida SHA y reconstruye sin inventario productivo",()=>{
  assert.match(server,/La huella del respaldo archivado no coincide/);
  assert.match(server,/verifyCanonicalBackupPackage\(admin, payload, job\.organization_id\)/);
  assert.match(server,/recoveryDrillId/);
});

test("el historial muestra resultado y próxima prueba de recuperación",()=>{
  assert.match(server,/recoverySchedule/);
  assert.match(server,/lastRecoveryTest/);
  assert.match(app,/Prueba semanal de recuperación/);
  assert.match(app,/recoverySchedule/);
});
