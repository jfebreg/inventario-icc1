import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/020_canonical_backup_manifests.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("los manifiestos de respaldo son inmutables y verificables", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_backup_manifests/);
  assert.match(migration, /payload_sha256.*\{64\}/);
  assert.match(migration, /logistics_backup_manifest_immutable/);
  assert.match(migration, /logistics_reject_immutable_change/);
});

test("la exportación usa una fotografía transaccional consistente", () => {
  assert.match(server, /BEGIN ISOLATION LEVEL REPEATABLE READ/);
  assert.match(server, /async function createCanonicalBackup/);
  assert.match(server, /ICC-LOGISTICS-BACKUP-1/);
  assert.match(server, /schemaVersion/);
  assert.match(server, /createHash\("sha256"\)\.update\(body\)/);
});

test("la organización raíz se filtra por su clave primaria", () => {
  assert.match(server, /table === "logistics_organizations" \? "id=\$1" : "organization_id=\$1"/);
  assert.doesNotMatch(server, /SELECT \* FROM logistics_organizations\s+WHERE organization_id=\$1/);
});

test("las referencias documentales usan la columna histórica real", () => {
  assert.match(server, /file\.ref AS reference/);
  assert.doesNotMatch(server, /file\.reference/);
});

test("el paquete contiene operación, auditoría y referencias documentales", () => {
  for (const dataset of ["stockBalances", "stockMovements", "stockLedger", "assetUnits",
    "inspectionRuns", "documents", "fileObjects", "auditEvents", "assetCompliance",
    "outboxEvents", "outboxDeliveryAttempts", "outboxSloPolicies"]) {
    assert.match(server, new RegExp(`${dataset}:`));
  }
  assert.match(server, /filePayloadsExcluded: true/);
  assert.match(server, /auditChainValid/);
});

test("sólo administración puede exportar y consultar manifiestos", () => {
  assert.match(server, /\/api\/admin\/canonical-backups/);
  assert.match(server, /Sólo el administrador puede exportar el libro mayor/);
  assert.match(server, /X-Content-SHA256/);
});

test("la configuración ofrece descarga e historial V2", () => {
  assert.match(app, /data-canonical-backup/);
  assert.match(app, /data-canonical-manifests/);
  assert.match(app, /function downloadCanonicalBackup/);
  assert.match(app, /function canonicalManifestsModal/);
});

test("la verificación de respaldo es no destructiva, auditable y valida controles críticos", () => {
  assert.match(server, /async function verifyCanonicalBackupPackage/);
  assert.match(server, /\/api\/admin\/canonical-backups\/verify/);
  assert.match(server, /maxBytes: 50_000_000, maxNodes: 500_000/);
  assert.match(server, /CANONICAL_BACKUP_VERIFIED/);
  assert.match(server, /CANONICAL_BACKUP_REJECTED/);
  for (const control of ["FORMAT_VALID", "MANIFEST_MATCH", "ORGANIZATION_MATCH", "SCHEMA_AVAILABLE", "DATASETS_DECLARED", "RECORD_COUNTS", "REQUIRED_DATASETS", "AUDIT_CHAIN"]) assert.match(server, new RegExp(control));
  assert.match(server, /drill_type,environment,status,backup_manifest_id/);
  assert.match(app, /data-verify-canonical-backup/);
  assert.match(app, /function verifyCanonicalBackupFile/);
  assert.match(app, /no modificó el inventario/);
});

test("cada exportación se archiva en Storage con ruta y huella verificables", () => {
  assert.match(server, /Respaldos_V2\/\$\{payload\.generatedAt\.slice\(0, 10\)\}/);
  assert.match(server, /"x-upsert": "false"/);
  assert.match(server, /storageArchived: Boolean\(storagePath\)/);
  assert.match(server, /No se pudo archivar el respaldo V2 en Storage/);
  assert.match(app, /metadata\?\.storageArchived/);
  assert.match(app, /Custodia/);
});

test("la recuperación desde Storage verifica la huella antes de descargar", () => {
  assert.match(server, /const canonicalBackupDownloadRoute/);
  assert.match(server, /canonical-backups.*download/);
  assert.match(server, /CANONICAL_BACKUP_ARCHIVE_CORRUPT/);
  assert.match(server, /CANONICAL_BACKUP_ARCHIVE_DOWNLOADED/);
  assert.match(server, /La copia archivada no supera la verificación SHA-256/);
  assert.match(server, /"X-Content-SHA256": actualSha256/);
  assert.match(app, /data-download-canonical-archive/);
  assert.match(app, /function downloadCanonicalArchive/);
});
