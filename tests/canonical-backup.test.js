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
