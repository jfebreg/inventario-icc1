import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("aprobar o verificar intenta archivar el informe inmediatamente", () => {
  assert.match(server, /\["approve", "verify"\]\.includes\(operation\)/);
  assert.match(server, /await ensureCanonicalInspectionReport\(inspectionId, apiProfile\)/);
  assert.match(server, /reportArchived = true/);
});

test("una falla conserva la aprobación y crea recuperación crítica", () => {
  assert.match(server, /La aprobación quedó registrada, pero el informe final requiere recuperación/);
  assert.match(server, /createInspectionReportRecoveryTask/);
  assert.match(server, /'INSPECTION_REPORT_ARCHIVE'/);
  assert.match(server, /INSPECTION_REPORT_ARCHIVE[\s\S]{0,200}'Crítica'/);
});

test("la recuperación sólo se resuelve al existir el documento", () => {
  assert.match(server, /async function resolveInspectionReportTask/);
  assert.match(server, /La tarea se resolverá automáticamente al archivar el informe final/);
  assert.match(app, /data-task-report/);
  assert.match(app, /retryCanonicalInspectionReport/);
  assert.match(app, /Reintentar informe/);
});

test("la interfaz informa el estado real de archivo tras aprobar", () => {
  assert.match(app, /outcome\.reportWarning/);
  assert.match(app, /informe final archivado/);
});
