import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/062_inspection_evidence_sla.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la cola calcula un SLA de dos horas sin duplicar el estado original", () => {
  assert.match(migration, /logistics_inspection_evidence_queue/);
  assert.match(migration, /INTERVAL '2 hours'/);
  assert.match(migration, /THEN 'OVERDUE'/);
  assert.match(migration, /evidence_status<>'VERIFIED'/);
});

test("el barrido crea tareas críticas y resuelve las verificadas", () => {
  assert.match(logistics, /taskType: "INSPECTION_EVIDENCE"/);
  assert.match(logistics, /overdueEvidence \? "Crítica" : "Alta"/);
  assert.match(logistics, /task\.task_type='INSPECTION_EVIDENCE'/);
  assert.match(logistics, /evidenceResolved: evidenceResolved\.rowCount/);
});

test("el archivado resuelve tarea y notificación en la transacción", () => {
  assert.match(logistics, /inspection-evidence-\$\{evidence\.rows\[0\]\.id\}/);
  assert.match(logistics, /notification-inspection-evidence-\$\{evidence\.rows\[0\]\.id\}/);
});

test("la tarea no se cierra manualmente y abre el reintento correcto", () => {
  assert.match(server, /task_type === "INSPECTION_EVIDENCE"/);
  assert.match(server, /se resolverá automáticamente al archivar la evidencia/);
  assert.match(app, /data-task-evidence/);
  assert.match(app, /Adjuntar evidencia/);
  assert.match(app, /canonicalInspectionId/);
});
