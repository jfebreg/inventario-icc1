import test from "node:test";
import assert from "node:assert/strict";
import { backupTaskResolutionError, attendBackupTaskAlerts } from "../lib/backup-task-resolution.js";

const protectedTypes = ["BACKUP_RPO_BREACH", "BACKUP_ARCHIVE_INTEGRITY",
  "BACKUP_RECOVERY_TEST_FAILED", "BACKUP_RECOVERY_OBJECTIVE_BREACH",
  "BACKUP_RECOVERY_TREND_BREACH", "BACKUP_RECOVERY_POLICY_REVIEW"];

test("la recuperación atiende avisos de escalamiento sólo de su propia tarea", async () => {
  let captured;
  const database={query:async (sql,params)=>{captured={sql,params};return {rowCount:2};}};
  const result=await attendBackupTaskAlerts(database,"backup-recovery-org-1");
  assert.deepEqual(captured.params,["backup-recovery-org-1"]);
  assert.match(captured.sql,/payload->>'taskId'=\$1/);
  assert.match(captured.sql,/read_at IS NULL/);
  assert.match(captured.sql,/severity IN \('warning','critical'\)/);
  assert.match(captured.sql,/BACKUP_RECOVERY_TEST_ESCALATED/);
  assert.match(captured.sql,/BACKUP_RECOVERY_POLICY_REVIEW_ESCALATED/);
  assert.doesNotMatch(captured.sql,/RECOVERED|REVIEWED/);
  assert.equal(result.rowCount,2);
});

test("las alertas de respaldo requieren corregir su causa antes de cerrarlas", () => {
  for (const type of protectedTypes) {
    assert.equal(typeof backupTaskResolutionError(type, "Resuelta"), "string");
    assert.equal(backupTaskResolutionError(type, "Pendiente"), null);
    assert.equal(backupTaskResolutionError(type, "En proceso"), null);
  }
});

test("las tareas operativas comunes conservan su cierre manual", () => {
  assert.equal(backupTaskResolutionError("Traslado", "Resuelta"), null);
  assert.equal(backupTaskResolutionError("Corrección", "Resuelta"), null);
});

test("cada alerta explica la evidencia necesaria para resolverla", () => {
  assert.match(backupTaskResolutionError("BACKUP_RECOVERY_POLICY_REVIEW", "Resuelta"), /guarda.*fundamento/);
  assert.match(backupTaskResolutionError("BACKUP_RECOVERY_OBJECTIVE_BREACH", "Resuelta"), /RPO y RTO/);
  assert.match(backupTaskResolutionError("BACKUP_ARCHIVE_INTEGRITY", "Resuelta"), /verificar/);
});
