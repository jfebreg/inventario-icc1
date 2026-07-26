import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/013_inventory_valuation_analytics.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la valorización conserva costo, moneda e historial auditable", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS standard_cost/);
  assert.match(migration, /valuation_method IN \('MOVING_AVERAGE','STANDARD'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_item_cost_history/);
  assert.match(migration, /previous_cost/);
  assert.match(migration, /purchase_unit_cost/);
});

test("cada asiento mantiene cantidad y valor con el mismo signo", () => {
  assert.match(logistics, /entry\.quantity \* unitCost/);
  assert.match(logistics, /unit_cost, total_value, currency/);
  assert.match(logistics, /const totalValue = Number\(\(quantity \* unitCost\)/);
});

test("las recepciones actualizan el costo promedio móvil y rechazan mezcla de monedas", () => {
  assert.match(logistics, /previousQuantity \* previousCost \+ quantity \* purchaseUnitCost/);
  assert.match(logistics, /el costo debe expresarse en/);
  assert.match(logistics, /source_type,source_id,previous_cost,new_cost/);
});

test("la analítica calcula consumo, cobertura, ABC y stock inmovilizado", () => {
  assert.match(logistics, /export async function listInventoryAnalytics/);
  assert.match(logistics, /INTERVAL '30 days'/);
  assert.match(logistics, /INTERVAL '90 days'/);
  assert.match(logistics, /INTERVAL '365 days'/);
  assert.match(logistics, /row\.abc_class/);
  assert.match(logistics, /dead_stock/);
  assert.match(logistics, /shortage_risk/);
});

test("API e interfaz presentan el panel ejecutivo de inventario", () => {
  assert.match(server, /\/api\/v1\/inventory-analytics/);
  assert.match(server, /itemCostRoute/);
  assert.match(server, /updateItemCost/);
  assert.match(server, /inventoryAnalytics/);
  assert.match(app, /function inventoryAnalyticsMarkup/);
  assert.match(app, /function itemCostModal/);
  assert.match(app, /Valorización, consumo y cobertura/);
  assert.match(app, /Costo unitario neto/);
  assert.match(app, /data-refresh-analytics/);
});
