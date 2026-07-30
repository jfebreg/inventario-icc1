import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app] = await Promise.all([
  readFile(new URL("../migrations/045_document_retention_governance.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo separa políticas, bloqueos y revisiones", () => {
  assert.match(migration, /logistics_retention_policies/);
  assert.match(migration, /logistics_legal_holds/);
  assert.match(migration, /logistics_retention_reviews/);
  assert.match(migration, /retention_years INTEGER/);
  assert.match(migration, /status IN \('ACTIVE','RELEASED'\)/);
});

test("la revisión sólo identifica candidatos y respeta bloqueos activos", () => {
  assert.match(server, /\/api\/admin\/retention-reviews/);
  assert.match(server, /hold\.status='ACTIVE'/);
  assert.match(server, /Revisión informativa; no elimina archivos automáticamente/);
  assert.doesNotMatch(server, /DELETE FROM logistics_documents/);
});

test("la interfaz permite configurar plazos y bloqueos legales", () => {
  assert.match(app, /Conservación documental/);
  assert.match(app, /data-edit-retention/);
  assert.match(app, /data-new-legal-hold/);
  assert.match(app, /Ningún archivo se elimina automáticamente/);
});
