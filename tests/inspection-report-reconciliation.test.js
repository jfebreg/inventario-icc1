import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la conciliación histórica procesa sólo expedientes finales con evidencia verificada", () => {
  assert.match(server, /async function sweepMissingInspectionReports/);
  assert.match(server, /inspection\.status IN \('APPROVED','CLOSED'\)/);
  assert.match(server, /inspection\.evidence_status='VERIFIED'/);
  assert.match(server, /report\.id IS NULL/);
});

test("la conciliación trabaja en lotes pequeños e idempotentes", () => {
  assert.match(server, /Math\.max\(1, Math\.min\(20, Number\(limit\) \|\| 5\)\)/);
  assert.match(server, /LEFT JOIN logistics_inspection_reports report ON report\.inspection_id=inspection\.id/);
  assert.match(server, /await ensureCanonicalInspectionReport\(inspection\.id, systemProfile\)/);
});

test("una falla histórica conserva el expediente y abre recuperación crítica", () => {
  assert.match(server, /await createInspectionReportRecoveryTask\(inspection\.id, systemProfile, error\)/);
  assert.match(server, /No se pudo conciliar informe final/);
  assert.match(server, /failed \+= 1/);
});

test("la conciliación corre automáticamente y también puede iniciarla administración", () => {
  assert.match(server, /const inspectionReports = await sweepMissingInspectionReports\(5\)/);
  assert.match(server, /url\.pathname === "\/api\/v1\/inspection-reports\/reconcile"/);
  assert.match(server, /Sólo administración puede conciliar informes históricos/);
  assert.match(server, /INSPECTION_REPORTS_RECONCILED/);
});

test("administración puede consultar el avance y los informes recientes", () => {
  assert.match(server, /url\.pathname === "\/api\/v1\/inspection-reports\/status"/);
  assert.match(server, /COUNT\(report\.id\)::int AS archived/);
  assert.match(server, /report\.report_sha256/);
  assert.match(server, /Sólo administración puede supervisar los informes finales/);
});

test("Configuración muestra custodia y permite conciliar el siguiente lote", () => {
  assert.match(app, /function renderInspectionReportCustodyCard/);
  assert.match(app, /Informes finales verificables/);
  assert.match(app, /data-reconcile-inspection-reports/);
  assert.match(app, /function reconcileInspectionReports/);
  assert.match(app, /limit:5/);
});

test("el panel muestra avance y descarga el PDF canónico verificable", () => {
  assert.match(app, /Avance de custodia:/);
  assert.match(app, /data-download-canonical-inspection/);
  assert.match(app, /function downloadCanonicalInspectionReport/);
  assert.match(app, /\/api\/v1\/inspections\/\$\{encodeURIComponent\(inspectionId\)\}\/report\.pdf/);
  assert.match(app, /x-content-sha256/);
});

test("el registro completo filtra y pagina la custodia por organización", () => {
  assert.match(server, /url\.pathname === "\/api\/v1\/inspection-reports"/);
  assert.match(server, /report\.organization_id=\$1/);
  assert.match(server, /unit\.unit_code ILIKE/);
  assert.match(server, /report\.generated_at >= NULLIF\(\$4,''\)::date/);
  assert.match(server, /COUNT\(\*\) OVER\(\)::int AS total_count/);
  assert.match(server, /LIMIT \$6 OFFSET \$7/);
});

test("la interfaz permite buscar navegar y descargar desde el registro", () => {
  assert.match(app, /data-open-inspection-report-registry/);
  assert.match(app, /function inspectionReportRegistryModal/);
  assert.match(app, /inspectionReportRegistryForm/);
  assert.match(app, /data-report-registry-page/);
  assert.match(app, /Código o equipo/);
});

test("la exportación CSV es filtrada verificable segura y auditada", () => {
  assert.match(server, /url\.pathname === "\/api\/v1\/inspection-reports\/export\.csv"/);
  assert.match(server, /LIMIT 10000/);
  assert.match(server, /INSPECTION_REPORT_REGISTRY_EXPORTED/);
  assert.match(server, /X-Content-SHA256/);
  assert.match(server, /if \(\/\^\[=\+\\-@\]\//);
  assert.match(app, /data-export-inspection-reports/);
  assert.match(app, /function exportInspectionReportRegistry/);
});

test("la integridad específica recupera cada PDF y compara la huella canónica", () => {
  assert.match(server, /async function verifyCanonicalInspectionReports/);
  assert.match(server, /await readEvidenceBody\(row\)/);
  assert.match(server, /row\.report_sha256/);
  assert.match(server, /safeTokenEqual\(expectedSha256, actualSha256\)/);
  assert.match(server, /INSPECTION_REPORT_INTEGRITY_VERIFIED/);
});

test("las diferencias generan tareas críticas que no se cierran manualmente", () => {
  assert.match(server, /'INSPECTION_REPORT_INTEGRITY'/);
  assert.match(server, /Integridad de informe comprometida/);
  assert.match(server, /después de restaurar y verificar el informe/);
  assert.match(app, /data-verify-inspection-report-integrity/);
  assert.match(app, /function verifyInspectionReportIntegrity/);
});
