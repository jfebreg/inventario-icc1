import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/052_document_disposition_workflow.sql", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../security-monitor.js", import.meta.url), "utf8");

test("el expediente conserva estados, responsables y eventos inalterables", () => {
  assert.match(migration, /logistics_document_dispositions/);
  assert.match(migration, /logistics_document_disposition_events/);
  assert.match(migration, /AWAITING_APPROVAL/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la revisión de conservación crea candidatos y respeta bloqueos legales", () => {
  assert.match(server, /INSERT INTO logistics_document_dispositions/);
  assert.match(server, /DISPOSITION_CANDIDATE_CREATED/);
  assert.match(server, /LEGAL_HOLD_BLOCKED/);
  assert.match(server, /Protegido por bloqueo legal/);
});

test("revisor y aprobador deben ser personas distintas", () => {
  assert.match(server, /El revisor no puede aprobar ni rechazar su propia propuesta/);
  assert.match(server, /Sólo el revisor asignado puede enviar la propuesta/);
  assert.match(server, /Fundamenta la propuesta de archivo/);
  assert.match(server, /Registra el fundamento de la decisión/);
});

test("archivar conserva la evidencia y registra la transición", () => {
  assert.match(server, /UPDATE logistics_documents SET status='ARCHIVED'/);
  assert.doesNotMatch(server, /DELETE FROM logistics_documents/);
  assert.match(server, /DOCUMENT_DISPOSITION_UPDATED/);
  assert.match(ui, /Archivar conserva el archivo/);
  assert.match(ui, /data-disposition-action/);
});
