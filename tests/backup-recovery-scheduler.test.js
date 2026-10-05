import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,objectiveMigration,objectiveHistoryMigration,trendPolicyMigration,reviewIntervalMigration,server,app]=await Promise.all([
  readFile(new URL("../migrations/075_backup_recovery_weekly_test.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/076_backup_recovery_objectives.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/077_backup_recovery_objective_history.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/078_backup_recovery_trend_policy.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/079_backup_recovery_review_interval.sql",import.meta.url),"utf8"),
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8")
]);

test("ratificar cierra la tarea y sus alertas antes de confirmar la política",()=>{
  const route=server.slice(server.indexOf('if (url.pathname === "/api/admin/canonical-backups/recovery-objective" && req.method === "PATCH")'));
  const close=route.indexOf("const resolvedReview = await client.query");
  const commit=route.indexOf('await client.query("COMMIT")');
  assert.ok(close>0 && close<commit);
  assert.match(route.slice(close,commit),/UPDATE inventory_notifications/);
  assert.match(route.slice(close,commit),/BACKUP_RECOVERY_POLICY_REVIEWED/);
  assert.match(route,/reviewResolved: Boolean\(resolvedReview.rowCount\)/);
});

test("los reintentos conservan el plazo y escalamiento de un incidente abierto",()=>{
  const start=server.indexOf("const taskTitle = recoveryFailure");
  const failure=server.slice(start,server.indexOf("if (recoveryFailure)",start));
  assert.match(failure,/due_at=CASE WHEN inventory_tasks.status='Resuelta' THEN EXCLUDED.due_at/);
  assert.match(failure,/ELSE COALESCE\(inventory_tasks.due_at,EXCLUDED.due_at\) END/);
  assert.match(failure,/ELSE COALESCE\(inventory_tasks.payload,'\{\}'::jsonb\)\|\|EXCLUDED.payload END/);
  assert.match(failure,/ELSE inventory_tasks.status END/);
  assert.match(failure,/incidentOwner.auth_user_id \|\| null/);
});

test("una nueva versión permite reabrir la revisión sin duplicar alertas del ciclo previo",()=>{
  const review=server.slice(server.indexOf("async function reviewBackupRecoveryPolicyValidity()"),server.indexOf("async function sweepScheduledLogisticsJobs()"));
  assert.match(review,/inventory_tasks.status='Resuelta'/);
  assert.match(review,/policyUpdatedAt' IS DISTINCT FROM EXCLUDED.payload->>'policyUpdatedAt'/);
  assert.match(review,/payload=EXCLUDED.payload,resolved_at=NULL/);
  assert.match(review,/notification-\$\{taskId\}-\$\{new Date\(policy.updated_at\).getTime\(\)\}/);
});

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
  assert.match(server,/SELECT target_rpo_minutes,target_rto_minutes,trend_window_size,trend_min_samples/);
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
  assert.match(app,/Historial de política de recuperación/);
  assert.match(app,/Motivo del cambio/);
});

test("el historial resume tendencia y brechas consecutivas de recuperación",()=>{
  assert.match(server,/ORDER BY completed_at DESC LIMIT 52/);
  assert.match(server,/compliancePercent/);
  assert.match(server,/worstRpoMinutes/);
  assert.match(server,/worstRtoMinutes/);
  assert.match(server,/consecutiveRecoveryBreaches/);
  assert.match(app,/data-recovery-trend/);
  assert.match(app,/Brechas seguidas/);
});

test("una tendencia degradada genera acción correctiva escalable y se cierra al recuperarse",()=>{
  assert.match(server,/BACKUP_RECOVERY_TREND_BREACH/);
  assert.match(server,/trendSampleSize >= trendMinSamples && trendCompliancePercent < trendTargetPercent/);
  assert.match(server,/trendCompliancePercent < trendCriticalPercent/);
  assert.match(server,/Mejorar tendencia de recuperación RPO\/RTO/);
  assert.match(server,/BACKUP_RECOVERY_TREND_BREACHED/);
  assert.match(server,/BACKUP_RECOVERY_TREND_RECOVERED/);
  assert.match(server,/BACKUP_RECOVERY_TREND_ESCALATED/);
  assert.match(server,/backup-recovery-trend-\$\{organizationId\}/);
});

test("el historial muestra responsable prioridad y plazo de la acción de tendencia",()=>{
  assert.match(server,/recoveryTrendAction/);
  assert.match(server,/profile\.name AS assignee_name/);
  assert.match(app,/data-recovery-trend-action/);
  assert.match(app,/Acción correctiva escalada/);
  assert.match(app,/Responsable:/);
  assert.match(app,/Plazo:/);
});

test("los umbrales de tendencia son configurables validados y auditados",()=>{
  assert.match(trendPolicyMigration,/trend_window_size INTEGER NOT NULL DEFAULT 12/);
  assert.match(trendPolicyMigration,/trend_target_percent INTEGER NOT NULL DEFAULT 95/);
  assert.match(trendPolicyMigration,/trend_critical_percent < trend_target_percent/);
  assert.match(server,/trendSampleSize >= trendMinSamples/);
  assert.match(server,/trendCompliancePercent < trendTargetPercent/);
  assert.match(server,/trendConsecutiveBreaches >= trendConsecutiveBreachLimit/);
  assert.match(server,/La política de tendencia contiene límites incompatibles/);
  assert.match(app,/Pruebas consideradas/);
  assert.match(app,/Cumplimiento esperado/);
});

test("el historial presenta la política de tendencia anterior y nueva",()=>{
  assert.match(app,/function recoveryTrendPolicySummary/);
  assert.match(app,/previous_/);
  assert.match(app,/Historial de política de recuperación/);
  assert.match(app,/Cada versión conserva RPO, RTO, umbrales de tendencia/);
  assert.match(app,/Nueva política/);
});

test("el historial reutiliza una sola consulta durante cada apertura",()=>{
  assert.match(app,/let canonicalBackupsPayloadPromise=null/);
  assert.match(app,/function canonicalBackupsPayload\(refresh=false\)/);
  assert.match(app,/canonicalBackupsPayloadPromise=null;await canonicalManifestsModalWithRecoveryTrend/);
  assert.match(app,/payload=await canonicalBackupsPayload\(\),health=payload\.backupHealth/);
  assert.match(app,/payload=await canonicalBackupsPayload\(\),action=payload\.backupHealth/);
});

test("el historial de política se exporta como evidencia verificable",()=>{
  assert.match(server,/recovery-objective\/history\.csv/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_HISTORY_EXPORTED/);
  assert.match(server,/Politica_Recuperacion_/);
  assert.match(server,/X-Content-SHA256/);
  assert.match(server,/\^\[=\+\\-@\]/);
  assert.match(app,/data-export-recovery-policy/);
  assert.match(app,/Evidencia exportada · SHA-256/);
});

test("la actualización evita sobrescribir una política modificada por otro administrador",()=>{
  assert.match(server,/expectedPolicyUpdatedAt/);
  assert.match(server,/SELECT \* FROM logistics_backup_recovery_objectives[\s\S]*FOR UPDATE/);
  assert.match(server,/La política cambió mientras estaba abierta/);
  assert.match(server,/conflict\.statusCode = 409/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_UPDATE_CONFLICT/);
  assert.match(app,/form\.dataset\.policyUpdatedAt=updatedAt/);
  assert.match(app,/policyUpdatedAt:e\.target\.dataset\.policyUpdatedAt/);
});

test("la política vencida genera revisión anual y se cierra al ratificarla",()=>{
  assert.match(server,/async function reviewBackupRecoveryPolicyValidity/);
  assert.match(server,/updated_at\+\(review_interval_days\*INTERVAL '1 day'\) AS review_due_at/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_REVIEW/);
  assert.match(server,/Revisar política periódica de recuperación/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_REVIEW_DUE/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_REVIEWED/);
  assert.match(server,/\$5::timestamptz\+INTERVAL '30 days'/);
  assert.match(server,/backupRecoveryPolicyReview = await reviewBackupRecoveryPolicyValidity/);
  assert.match(app,/data-recovery-policy-review/);
  assert.match(app,/Revisión periódica:/);
  assert.match(app,/Vigente hasta/);
  assert.match(server,/review_interval_days,updated_at/);
  assert.match(server,/recoveryPolicyReviewAction/);
  assert.match(server,/task_type='BACKUP_RECOVERY_POLICY_REVIEW'/);
  assert.match(server,/task\.payload->>'reviewDueAt' AS review_due_at/);
  assert.match(app,/data-recovery-policy-review-action/);
  assert.match(app,/Responsable:/);
  assert.match(app,/Fecha de revisión:/);
  assert.match(app,/Plazo de escalamiento:/);
});

test("la revisión avisa treinta días antes y vuelve a notificar al vencer",()=>{
  assert.match(server,/const dueSoon = reviewDueAtMs <= Date\.now\(\) \+ 30 \* 86400000/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_REVIEW_UPCOMING/);
  assert.match(server,/overdueNotifiedAt/);
  assert.match(server,/notification-\$\{taskId\}-overdue/);
  assert.match(server,/status: overdue \? "OVERDUE" : "UPCOMING"/);
});

test("la periodicidad de revisión es configurable y se conserva como evidencia",()=>{
  assert.match(reviewIntervalMigration,/review_interval_days INTEGER NOT NULL DEFAULT 365/);
  assert.match(reviewIntervalMigration,/BETWEEN 30 AND 730/);
  assert.match(server,/reviewIntervalDays = Number/);
  assert.match(server,/La revisión periódica debe estar entre 30 y 730 días/);
  assert.match(server,/previous_review_interval_days,review_interval_days/);
  assert.match(app,/name="reviewIntervalDays"/);
  assert.match(app,/cada \$\{interval\} días/);
});

test("la revisión anual vencida afecta salud se escala y bloquea preparación",()=>{
  assert.match(server,/OR task_type='BACKUP_RECOVERY_POLICY_REVIEW'/);
  assert.match(server,/BACKUP_RECOVERY_POLICY_REVIEW_ESCALATED/);
  assert.match(server,/Escalamiento: revisión anual de recuperación vencida/);
  assert.match(server,/"backupRecoveryPolicyReview"/);
  assert.match(server,/policyReviewDaysOverdue > 30 \? "FAIL"/);
  assert.match(server,/backup-recovery-policy-review-\$\{logisticsOrganizationId\}/);
});
