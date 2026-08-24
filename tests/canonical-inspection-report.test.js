import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/063_canonical_inspection_reports.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("cada inspección conserva una única versión final inmutable", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_inspection_reports/);
  assert.match(migration, /UNIQUE \(inspection_id\)/);
  assert.match(migration, /report_sha256 TEXT NOT NULL/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
});

test("el servidor reconstruye el informe desde tablas canónicas", () => {
  assert.match(server, /async function canonicalInspectionReportData/);
  assert.match(server, /FROM logistics_inspection_runs inspection/);
  assert.match(server, /FROM logistics_inspection_answers answer/);
  assert.match(server, /FROM logistics_digital_attestations/);
  assert.match(server, /inventory_worker_signatures/);
});

test("sólo las inspecciones aprobadas o cerradas generan informe final", () => {
  assert.match(server, /\["APPROVED", "CLOSED"\]\.includes\(reportData\.status\)/);
  assert.match(server, /inspection-final-report:/);
  assert.match(server, /relationship: "FINAL_REPORT"/);
  assert.match(server, /X-Report-Status": "FINAL"/);
});

test("la aplicación distingue vista preliminar e informe final", () => {
  assert.match(app, /finalReport=Boolean\(i\.canonicalInspectionId/);
  assert.match(app, /\/api\/v1\/inspections\/\$\{encodeURIComponent\(i\.canonicalInspectionId\)\}\/report\.pdf/);
  assert.match(app, /_FINAL/);
  assert.match(app, /if\(!finalReport\)downloadGeneratedHtml/);
});
