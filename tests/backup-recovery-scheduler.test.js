import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,objectiveMigration,objectiveHistoryMigration,server,app]=await Promise.all([
  readFile(new URL("../migrations/075_backup_recovery_weekly_test.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/076_backup_recovery_objectives.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/077_backup_recovery_objective_history.sql",import.meta.url),"utf8"),
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

test("la recuperación automática mide RPO y RTO contra objetivos formales",()=>{
  assert.match(server,/objectiveResult/);
  assert.match(server,/SELECT target_rpo_minutes,target_rto_minutes FROM logistics_backup_recovery_objectives/);
  assert.match(server,/targetRpoMinutes, targetRtoMinutes, measuredRpoMinutes, measuredRtoMinutes/);
  assert.match(server,/measured_rpo_minutes<=target_rpo_minutes AS rpo_compliant/);
  assert.match(server,/recoveryMetrics/);
  assert.match(app,/data-recovery-metrics/);
  assert.match(app,/Fuera de objetivo/);
});

test("una desviación RPO o RTO crea una alerta propia y luego se resuelve",()=>{
  assert.match(server,/BACKUP_RECOVERY_OBJECTIVE_BREACH/);
  assert.match(server,/measuredRpoMinutes <= targetRpoMinutes/);
  assert.match(server,/measuredRtoMinutes <= targetRtoMinutes/);
  assert.match(server,/Recuperación fuera del objetivo RPO\/RTO/);
  assert.match(server,/BACKUP_RECOVERY_OBJECTIVE_BREACHED/);
  assert.match(server,/BACKUP_RECOVERY_OBJECTIVE_RECOVERED/);
  assert.match(server,/backup-recovery-objective-\$\{organizationId\}/);
});

test("la desviación persistente se escala y bloquea preparación productiva",()=>{
  assert.match(server,/OR task_type='BACKUP_RECOVERY_OBJECTIVE_BREACH'/);
  assert.match(server,/BACKUP_RECOVERY_OBJECTIVE_ESCALATED/);
  assert.match(server,/Escalamiento: objetivo RPO\/RTO aún incumplido/);
  assert.match(server,/"backupRecoveryObjective"/);
  assert.match(server,/objectiveStatus = !recoveryObjective \? "WARN"/);
  assert.match(server,/rpoWithinTarget && rtoWithinTarget \? "PASS" : "FAIL"/);
});

test("la organización configura objetivos RPO y RTO explícitos",()=>{
  assert.match(objectiveMigration,/CREATE TABLE IF NOT EXISTS logistics_backup_recovery_objectives/);
  assert.match(objectiveMigration,/target_rpo_minutes INTEGER NOT NULL DEFAULT 1440/);
  assert.match(objectiveMigration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(server,/BACKUP_RECOVERY_OBJECTIVE_UPDATED/);
  assert.match(server,/logistics_backup_recovery_objectives/);
  assert.match(app,/Configurar objetivo/);
  assert.match(app,/backupRecoveryObjectiveForm/);
});

test("cada cambio de objetivo conserva una versión inmutable y justificada",()=>{
  assert.match(objectiveHistoryMigration,/logistics_backup_recovery_objective_history/);
  assert.match(objectiveHistoryMigration,/BEFORE UPDATE OR DELETE/);
  assert.match(objectiveHistoryMigration,/previous_rpo_minutes/);
  assert.match(server,/SELECT \* FROM logistics_backup_recovery_objectives[\s\S]*FOR UPDATE/);
  assert.match(server,/reason\.length < 10/);
  assert.match(server,/recoveryObjectiveHistory/);
  assert.match(app,/Historial de objetivos RPO\/RTO/);
  assert.match(app,/Motivo del cambio/);
});
