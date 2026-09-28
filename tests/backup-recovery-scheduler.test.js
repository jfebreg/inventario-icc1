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
  assert.match(server,/recoveryIncident/);
  assert.match(app,/Incidente escalado/);
  assert.match(app,/Incidente abierto/);
  assert.match(app,/Requiere atención del administrador central/);
});

test("una falla de recuperación crea una tarea crítica propia y el éxito la resuelve",()=>{
  assert.match(server,/BACKUP_RECOVERY_TEST_FAILED/);
  assert.match(server,/backup-recovery-\$\{job\.organization_id\}/);
  assert.match(server,/Falló la prueba semanal de recuperación V2/);
  assert.match(server,/jobCode: job\.job_code/);
});

test("el incidente notifica en tiempo real y conserva su transición en auditoría",()=>{
  assert.match(server,/notification-\$\{taskId\}-\$\{executionId\}/);
  assert.match(server,/BACKUP_RECOVERY_TEST_FAILED','scheduled_job/);
  assert.match(server,/BACKUP_RECOVERY_TEST_RECOVERED/);
  assert.match(server,/notification-\$\{taskId\}-recovered-\$\{executionId\}/);
  assert.match(server,/correlation_id,source,after_data/);
  assert.match(server,/UPDATE inventory_notifications SET read_at=COALESCE\(read_at,NOW\(\)\)/);
});

test("una recuperación no restablecida se escala una sola vez",()=>{
  assert.match(server,/task_type='SCHEDULER_FAILURE' OR task_type='BACKUP_RECOVERY_TEST_FAILED'/);
  assert.match(server,/BACKUP_RECOVERY_TEST_ESCALATED/);
  assert.match(server,/Escalamiento: recuperación de respaldos no restablecida/);
  assert.match(server,/administrator\.auth_user_id/);
  assert.match(server,/recoveryEscalation \? 'BACKUP_RECOVERY_TEST_ESCALATED'/);
});

test("la preparación productiva detecta recuperación ausente detenida fallida o atrasada",()=>{
  assert.match(server,/"backupRecovery"/);
  assert.match(server,/recoverySchedule\.last_status === "FAILED"/);
  assert.match(server,/La prueba automática está detenida/);
  assert.match(server,/La prueba semanal está atrasada/);
});

test("el administrador puede ejecutar inmediatamente la misma prueba desde Storage",()=>{
  assert.match(server,/\/api\/admin\/canonical-backups\/recovery-test/);
  assert.match(server,/BACKUP_RECOVERY_TEST_REQUESTED/);
  assert.match(server,/UPDATE logistics_scheduled_jobs SET next_run_at=NOW\(\)/);
  assert.match(server,/await runDueCanonicalBackupJobs\(\)/);
  assert.match(app,/data-run-backup-recovery/);
  assert.match(app,/Probar recuperación ahora/);
  assert.match(app,/Probando desde Storage/);
});
