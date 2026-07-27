import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/021_item_uom_packaging.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el catálogo separa unidades y presentaciones por artículo", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_units_of_measure/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_item_uoms/);
  assert.match(migration, /conversion_to_base NUMERIC\(18,6\)/);
  assert.match(migration, /logistics_item_uoms_base_idx/);
  assert.match(migration, /logistics_item_uoms_barcode_idx/);
});

test("la migración conserva la unidad actual como base", () => {
  assert.match(migration, /UPPER\(item\.unit_of_measure\)/);
  assert.match(migration, /conversion_to_base,package_level,is_base/);
  assert.match(migration, /'EACH',TRUE,TRUE,TRUE/);
});

test("las presentaciones validan conversiones y activos serializados", () => {
  assert.match(logistics, /export async function upsertItemPresentation/);
  assert.match(logistics, /La unidad base siempre debe equivaler a 1/);
  assert.match(logistics, /Los activos serializados se administran individualmente/);
  assert.match(logistics, /ITEM_PRESENTATION_REGISTERED/);
});

test("sku, gtin, código de barras y código de proveedor resuelven el artículo", () => {
  assert.match(logistics, /export async function resolveItemIdentifier/);
  assert.match(logistics, /presentation\.barcode/);
  assert.match(logistics, /presentation\.supplier_code/);
  assert.match(server, /item-identifiers/);
});

test("la interfaz configura empaques y aplica su equivalencia al escanear", () => {
  assert.match(app, /function itemPresentationsMarkup/);
  assert.match(app, /function itemPresentationModal/);
  assert.match(app, /itemPresentationForm/);
  assert.match(app, /scannedPresentationConversion/);
  assert.match(server, /\/api\/v1\/item-presentations/);
});
