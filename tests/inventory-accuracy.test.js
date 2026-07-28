import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/034_inventory_accuracy_view.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la vista canónica usa el resultado final autorizado", () => {
  assert.match(migration, /logistics_cycle_count_results_v/);
  assert.match(migration, /COALESCE\(line\.recount_quantity,line\.counted_quantity\)/);
  assert.match(migration, /variance_quantity/);
  assert.match(migration, /absolute_variance_value/);
  assert.match(migration, /WHERE cycle\.status='POSTED'/);
});

test("el informe calcula exactitud y cumplimiento de tolerancia", () => {
  assert.match(logistics, /export async function listInventoryAccuracy/);
  assert.match(logistics, /exact_lines/);
  assert.match(logistics, /within_tolerance_lines/);
  assert.match(logistics, /accuracyPercent/);
  assert.match(logistics, /toleranceCompliancePercent/);
});

test("la consulta respeta centro y período del usuario", () => {
  assert.match(logistics, /profile\?\.admin \? null : text\(profile\?\.cost_center\)/);
  assert.match(logistics, /result\.posted_at>=NOW\(\)-/);
  assert.match(logistics, /\$3::text IS NULL OR center\.name=\$3/);
});

test("el análisis entrega bodegas, causas, valorización y tendencia", () => {
  assert.match(logistics, /const warehouses =/);
  assert.match(logistics, /variance_reason_code/);
  assert.match(logistics, /GROUP BY result\.currency/);
  assert.match(logistics, /result\.posted_at::date AS count_date/);
});

test("API y panel permiten cambiar la ventana de análisis", () => {
  assert.match(server, /\/api\/v1\/inventory-accuracy/);
  assert.match(server, /listInventoryAccuracy/);
  assert.match(app, /function inventoryAccuracyMarkup/);
  assert.match(app, /data-accuracy-days="30"/);
  assert.match(app, /Causas de diferencias/);
  assert.match(app, /Tendencia reciente/);
});

test("el KPI general también considera el reconteo final", () => {
  assert.match(logistics, /ABS\(COALESCE\(line\.recount_quantity,line\.counted_quantity\)/);
});
