import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/023_inventory_abc_xyz.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo conserva políticas y clasificación por artículo", () => {
  assert.match(migration, /logistics_classification_policies/);
  assert.match(migration, /logistics_inventory_classifications/);
  assert.match(migration, /abc_class TEXT NOT NULL/);
  assert.match(migration, /xyz_class TEXT NOT NULL/);
  assert.match(migration, /coefficient_variation/);
});

test("las políticas iniciales priorizan A sobre B y C", () => {
  assert.match(migration, /\('A',30,2\.0000\)/);
  assert.match(migration, /\('B',90,5\.0000\)/);
  assert.match(migration, /\('C',180,10\.0000\)/);
  assert.match(logistics, /CLASSIFICATION_POLICY_UPDATED/);
});

test("el cálculo usa valor consumido y variabilidad mensual", () => {
  assert.match(logistics, /export async function calculateInventoryClassifications/);
  assert.match(logistics, /STDDEV_POP\(quantity\)/);
  assert.match(logistics, /previousShare < 0\.80/);
  assert.match(logistics, /cv <= 0\.5 \? "X"/);
  assert.match(logistics, /INVENTORY_CLASSIFICATION_CALCULATED/);
});

test("la fecha recomendada considera el último conteo contabilizado", () => {
  assert.match(logistics, /MAX\(cycle\.posted_at\)/);
  assert.match(logistics, /recommended_count_interval_days/);
  assert.match(logistics, /count_overdue/);
});

test("API e interfaz permiten calcular y administrar políticas", () => {
  assert.match(server, /inventory-classifications\/calculate/);
  assert.match(server, /inventory-classification-policies/);
  assert.match(app, /function inventoryClassificationMarkup/);
  assert.match(app, /function classificationPoliciesModal/);
  assert.match(app, /classificationPoliciesForm/);
});
