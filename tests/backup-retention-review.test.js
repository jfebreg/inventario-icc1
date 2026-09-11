import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,server,app]=await Promise.all([
  readFile(new URL("../migrations/073_backup_retention_reviews.sql",import.meta.url),"utf8"),
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8")
]);

test("las decisiones de conservación son inmutables y nunca borran respaldos",()=>{
  assert.match(migration,/decision IN \('KEEP','ARCHIVE'\)/);
  assert.match(migration,/BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(server,/DELETE FROM logistics_backup_manifests/);
});
test("la revisión exige administrador fundamento y deja auditoría",()=>{
  assert.match(server,/BACKUP_RETENTION_REVIEWED/);
  assert.match(server,/reason\.length < 10/);
  assert.match(server,/Sólo el administrador puede revisar la conservación/);
});
test("el historial permite resolver las copias fuera de ventana",()=>{
  assert.match(app,/data-review-backup-retention/);
  assert.match(app,/Conservar protegida/);
  assert.match(app,/Archivar permanentemente/);
});
