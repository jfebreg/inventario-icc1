import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,server,app]=await Promise.all([
  readFile(new URL("../migrations/073_backup_retention_reviews.sql",import.meta.url),"utf8"),
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8")
]);
const resolutionMigration=await readFile(new URL("../migrations/074_backup_retention_review_resolution.sql",import.meta.url),"utf8");

test("las decisiones de conservación son inmutables y nunca borran respaldos",()=>{
  assert.match(migration,/decision IN \('KEEP','ARCHIVE'\)/);
  assert.match(migration,/BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(server,/DELETE FROM logistics_backup_manifests/);
});
test("la revisión exige administrador fundamento y deja auditoría",()=>{
  assert.match(server,/BACKUP_RETENTION_REVIEWED/);
  assert.match(server,/reason\.length < 10/);
  assert.match(server,/Sólo el administrador puede revisar la conservación/);
  assert.match(server,/ya posee una decisión de conservación inmutable/);
});
test("el historial permite resolver las copias fuera de ventana",()=>{
  assert.match(app,/data-review-backup-retention/);
  assert.match(app,/Conservar protegida/);
  assert.match(app,/Archivar permanentemente/);
  assert.match(app,/retention_reviewed_by_name/);
  assert.match(app,/Resuelta/);
});
test("cada manifiesto admite una sola resolución de conservación",()=>{
  assert.match(resolutionMigration,/CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(resolutionMigration,/organization_id,backup_manifest_id/);
  assert.match(server,/retention_review_id/);
});
