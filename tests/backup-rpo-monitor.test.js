import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/071_backup_rpo_monitor.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la agenda incorpora vigilancia diaria del RPO de respaldo", () => {
  assert.match(migration, /BACKUP_RPO_DAILY_CHECK/);
  assert.match(migration, /America\/Santiago/);
  assert.match(migration, /ON CONFLICT \(organization_id,job_code\) DO NOTHING/);
});

test("el monitor abre y cierra una tarea sin alterar inventario", () => {
  assert.match(logistics, /BACKUP_RPO_BREACH/);
  assert.match(logistics, /ageHours > 24/);
  assert.match(logistics, /status='Resuelta'/);
  assert.doesNotMatch(logistics, /BACKUP_RPO_DAILY_CHECK[\s\S]{0,2000}UPDATE logistics_stock_balances/);
});

test("el servidor genera y custodia automáticamente el respaldo vencido", () => {
  assert.match(server, /async function runDueCanonicalBackupJobs/);
  assert.match(server, /icc:canonical-backup-scheduler/);
  assert.match(server, /await createCanonicalBackup\(admin, job\.organization_id\)/);
  assert.match(server, /canonicalBackup = await runDueCanonicalBackupJobs/);
  assert.match(logistics, /'BACKUP_RPO_DAILY_CHECK'/);
});

test("cada ejecución revisa integridad y disponibilidad de copias históricas", () => {
  assert.match(server, /async function verifyArchivedCanonicalBackups/);
  assert.match(server, /await verifyArchivedCanonicalBackups\(admin, 5, job\.organization_id\)/);
  assert.match(server, /CANONICAL_BACKUP_ARCHIVE_INTEGRITY_FAILED/);
  assert.match(server, /CANONICAL_BACKUP_ARCHIVE_INTEGRITY_RECOVERED/);
  assert.match(server, /backup-archive-integrity-/);
  assert.match(server, /safeTokenEqual\(actualSha256, manifest\.payload_sha256\)/);
});

test("los respaldos automáticos quedan aislados por organización", () => {
  assert.match(server, /createCanonicalBackup\(actorProfile, organizationId = logisticsOrganizationId\)/);
  assert.match(server, /Respaldos_V2\/\$\{organizationId\}\//);
  assert.match(server, /verifyArchivedCanonicalBackups\(actorProfile, limit = 5, organizationId = logisticsOrganizationId\)/);
});

test("el historial resume RPO, agenda, verificación y alertas", () => {
  assert.match(server, /backupHealth/);
  assert.match(server, /lastAutomaticVerification/);
  assert.match(server, /openAlerts/);
  assert.match(app, /Última revisión/);
  assert.match(app, /Objetivo:/);
  assert.match(app, /Alertas abiertas/);
});

test("la preparación productiva exige la migración del monitor", () => {
  assert.match(server, /latestMigration\.startsWith\("071_"\)/);
});
