import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/019_asset_compliance_records.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("los antecedentes técnicos pertenecen a una unidad serializada", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_asset_compliance_records/);
  assert.match(migration, /asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units/);
  assert.match(migration, /CERTIFICATION.*CALIBRATION.*WARRANTY.*INSURANCE/s);
  assert.match(migration, /reminder_days BETWEEN 0 AND 365/);
});

test("la renovación conserva el registro anterior", () => {
  assert.match(migration, /supersedes_id UUID REFERENCES logistics_asset_compliance_records/);
  assert.match(logistics, /status='RENEWED'/);
  assert.match(logistics, /ASSET_COMPLIANCE_RENEWED/);
  assert.match(logistics, /supersedesId/);
});

test("el estado efectivo distingue vencidos y próximos a vencer", () => {
  assert.match(logistics, /THEN 'EXPIRED'/);
  assert.match(logistics, /THEN 'EXPIRING'/);
  assert.match(logistics, /days_remaining/);
  assert.match(logistics, /expired_asset_compliance/);
});

test("la API protege el alcance y genera tareas críticas", () => {
  assert.match(server, /\/api\/v1\/asset-compliance/);
  assert.match(server, /syncAssetComplianceTask/);
  assert.match(server, /Cumplimiento de activo/);
  assert.match(server, /profileMayAccessWarehouse/);
});

test("la interfaz permite registrar, renovar, revocar y adjuntar respaldo", () => {
  assert.match(app, /function assetComplianceMarkup/);
  assert.match(app, /id="assetComplianceForm"/);
  assert.match(app, /data-renew-compliance/);
  assert.match(app, /data-revoke-compliance/);
  assert.match(app, /ASSET_COMPLIANCE/);
  assert.match(app, /Descargar respaldo/);
});
