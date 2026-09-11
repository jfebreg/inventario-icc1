import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration,server,app]=await Promise.all([
  readFile(new URL("../migrations/072_backup_retention_policy.sql",import.meta.url),"utf8"),
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8")
]);

test("la retención nunca habilita borrado automático",()=>{
  assert.match(migration,/automatic_deletion BOOLEAN NOT NULL DEFAULT FALSE CHECK \(automatic_deletion=FALSE\)/);
  assert.match(server,/automatic_deletion=FALSE/);
});
test("la política está aislada validada y auditada",()=>{
  assert.match(server,/canonical-backups\/policy/);
  assert.match(server,/BACKUP_RETENTION_POLICY_UPDATED/);
  assert.match(server,/dailyDays < 7/);
  assert.match(migration,/organization_id UUID PRIMARY KEY/);
});
test("el historial permite configurar plazos comprensibles",()=>{
  assert.match(app,/backupRetentionPolicyModal/);
  assert.match(app,/Retención sin eliminación automática/);
  assert.match(app,/backupRetentionPolicyForm/);
});
