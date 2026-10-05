const automaticResolution = new Map([
  ["BACKUP_RPO_BREACH", "La tarea se resolverá cuando se genere y verifique un respaldo dentro del plazo comprometido."],
  ["BACKUP_ARCHIVE_INTEGRITY", "La tarea se resolverá después de recuperar y verificar la copia del respaldo."],
  ["BACKUP_RECOVERY_TEST_FAILED", "La tarea se resolverá cuando una prueba de recuperación termine correctamente."],
  ["BACKUP_RECOVERY_OBJECTIVE_BREACH", "La tarea se resolverá cuando la prueba de recuperación cumpla los objetivos RPO y RTO."],
  ["BACKUP_RECOVERY_TREND_BREACH", "La tarea se resolverá cuando las pruebas de recuperación restablezcan el cumplimiento de la política de tendencia."],
  ["BACKUP_RECOVERY_POLICY_REVIEW", "Revisa y guarda la política de recuperación con un fundamento para resolver esta tarea."]
]);

export function backupTaskResolutionError(taskType, requestedStatus) {
  return requestedStatus === "Resuelta" ? automaticResolution.get(taskType) || null : null;
}
