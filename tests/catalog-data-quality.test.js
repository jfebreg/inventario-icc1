import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/035_catalog_data_quality.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo conserva incidencias y agenda una revisión diaria", () => {
  assert.match(migration, /logistics_data_quality_issues/);
  assert.match(migration, /issue_key TEXT NOT NULL/);
  assert.match(migration, /DATA_QUALITY_DAILY_REVIEW/);
  assert.match(migration, /America\/Santiago',10/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la revisión cubre dimensiones críticas del artículo maestro", () => {
  assert.match(logistics, /MISSING_FAMILY/);
  assert.match(logistics, /MISSING_BASE_UOM/);
  assert.match(logistics, /ZERO_STANDARD_COST/);
  assert.match(logistics, /MISSING_STOCK_POLICY/);
  assert.match(logistics, /MISSING_SERIAL/);
});

test("las incidencias se actualizan y resuelven sin borrar historial", () => {
  assert.match(logistics, /ON CONFLICT \(organization_id,issue_key\) DO UPDATE/);
  assert.match(logistics, /SET status='RESOLVED'/);
  assert.match(logistics, /resolved_at=NOW\(\)/);
  assert.match(logistics, /CATALOG_DATA_QUALITY_REVIEW/);
});

test("la revisión genera tareas y alertas según severidad", () => {
  assert.match(logistics, /task_type='DATA_QUALITY'/);
  assert.match(logistics, /issue\.severity === "CRITICAL"/);
  assert.match(logistics, /notification-\$\{taskId\}/);
  assert.match(logistics, /status=CASE WHEN inventory_tasks\.status='En proceso'/);
});

test("el trabajo programado procesa calidad de datos", () => {
  assert.match(logistics, /job\.job_code === "DATA_QUALITY_DAILY_REVIEW"/);
  assert.match(logistics, /reviewCatalogDataQuality\(pool, job\.organization_id\)/);
  assert.match(logistics, /openIssues: outcome\?\.openIssues/);
});

test("API y panel están limitados a administración", () => {
  assert.match(server, /\/api\/v1\/catalog-quality\/review/);
  assert.match(server, /Sólo administración puede ejecutar esta revisión/);
  assert.match(app, /function catalogQualityMarkup/);
  assert.match(app, /data-review-catalog/);
  assert.match(app, /Gobierno de datos maestros/);
});
