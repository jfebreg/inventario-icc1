import test from "node:test";
import assert from "node:assert/strict";
import { backupTaskResolutionError } from "../lib/backup-task-resolution.js";

const protectedTypes = ["BACKUP_RPO_BREACH", "BACKUP_ARCHIVE_INTEGRITY",
  "BACKUP_RECOVERY_TEST_FAILED", "BACKUP_RECOVERY_OBJECTIVE_BREACH",
  "BACKUP_RECOVERY_TREND_BREACH", "BACKUP_RECOVERY_POLICY_REVIEW"];

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
