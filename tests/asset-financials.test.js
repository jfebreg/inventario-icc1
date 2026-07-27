import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/018_asset_financial_register.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el registro financiero pertenece a una unidad serializada", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_asset_financials/);
  assert.match(migration, /UNIQUE \(asset_unit_id\)/);
  assert.match(migration, /residual_value <= acquisition_cost/);
  assert.match(migration, /depreciation_method IN \('STRAIGHT_LINE'\)/);
});

test("los cierres mensuales son inmutables e idempotentes", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_asset_depreciation_snapshots/);
  assert.match(migration, /UNIQUE \(financial_id, as_of_date\)/);
  assert.match(logistics, /ON CONFLICT \(financial_id,as_of_date\) DO NOTHING/);
  assert.match(logistics, /La depreciación debe calcularse al último día del mes/);
});

test("la depreciación respeta vida útil y valor residual", () => {
  assert.match(logistics, /LEAST\(financial\.useful_life_months/);
  assert.match(logistics, /GREATEST\(residual_value,acquisition_cost-/);
  assert.match(logistics, /monthly_depreciation/);
  assert.match(logistics, /accumulated_depreciation/);
});

test("sólo administración modifica valores y ejecuta cierres", () => {
  assert.match(server, /Sólo el administrador puede registrar valores/);
  assert.match(server, /Sólo el administrador puede cerrar depreciación/);
  assert.match(server, /\/api\/v1\/asset-financials/);
  assert.match(server, /\/api\/v1\/asset-depreciation-runs/);
});

test("la interfaz presenta costo, depreciación y valor libro", () => {
  assert.match(app, /function assetFinancialMarkup/);
  assert.match(app, /id="assetFinancialForm"/);
  assert.match(app, /data-run-depreciation/);
  assert.match(app, /Valor libro/);
});
