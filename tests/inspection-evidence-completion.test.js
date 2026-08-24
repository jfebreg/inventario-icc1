import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/061_inspection_evidence_completion.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la inspección registra el estado formal de su evidencia", () => {
  assert.match(migration, /evidence_required BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(migration, /evidence_status TEXT NOT NULL DEFAULT 'PENDING'/);
  assert.match(migration, /evidence_document_id UUID REFERENCES logistics_documents\(id\)/);
  assert.match(migration, /logistics_inspection_evidence_pending_idx/);
});

test("las evidencias históricas activas quedan conciliadas", () => {
  assert.match(migration, /WITH latest_evidence AS/);
  assert.match(migration, /link\.entity_type='inspection_run'/);
  assert.match(migration, /link\.relationship='EVIDENCE'/);
  assert.match(migration, /SET evidence_status='VERIFIED'/);
});

test("la base de datos impide aprobar sin evidencia verificada", () => {
  assert.match(migration, /NEW\.status IN \('APPROVED','CLOSED'\)/);
  assert.match(migration, /NEW\.evidence_status<>'VERIFIED'/);
  assert.match(migration, /logistics_inspection_requires_evidence/);
});

test("archivar el documento enlaza y verifica la evidencia en la misma transacción", () => {
  assert.match(logistics, /entityType\)\.toLowerCase\(\) === "inspection_run"/);
  assert.match(logistics, /SET evidence_status='VERIFIED',evidence_document_id=\$1/);
  assert.match(logistics, /La inspección asociada a la evidencia no existe/);
});

test("el servicio y la interfaz ofrecen recuperación explícita", () => {
  assert.match(logistics, /\["APPROVE", "VERIFY_CORRECTION"\]\.includes\(action\)/);
  assert.match(logistics, /aún no tiene evidencia digital verificada/);
  assert.match(app, /data-retry-inspection-evidence/);
  assert.match(app, /inspectionEvidenceForm/);
});
