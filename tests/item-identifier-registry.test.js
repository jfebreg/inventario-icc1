import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isValidGtin } from "../lib/logistics.js";

const [migration, logistics, app] = await Promise.all([
  readFile(new URL("../migrations/038_item_identifier_registry.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el registro canónico separa tipo, valor normalizado y presentación", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_item_identifiers/);
  assert.match(migration, /item_uom_id UUID REFERENCES logistics_item_uoms/);
  assert.match(migration, /normalized_value TEXT NOT NULL/);
  assert.match(migration, /logistics_item_identifiers_value_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la migración incorpora SKU, GTIN y códigos de presentación vigentes", () => {
  assert.match(migration, /SELECT item\.organization_id,item\.id,'SKU'/);
  assert.match(migration, /COALESCE\(BTRIM\(item\.gtin\),''\)<>''/);
  assert.match(migration, /presentation\.barcode/);
  assert.match(migration, /ON CONFLICT DO NOTHING/);
});

test("el dígito verificador GS1 se calcula para longitudes válidas", () => {
  assert.equal(isValidGtin("4006381333931"), true);
  assert.equal(isValidGtin("96385074"), true);
  assert.equal(isValidGtin("4006381333932"), false);
  assert.equal(isValidGtin("12345"), false);
});

test("cada alta sincroniza SKU y GTIN y rechaza códigos compartidos", () => {
  assert.match(logistics, /upsertItemIdentifierWithClient/);
  assert.match(logistics, /identifierType: "SKU"/);
  assert.match(logistics, /if \(text\(input\.gtin\)\)/);
  assert.match(logistics, /ya está asignado a otro artículo/);
});

test("cambiar el código de una presentación desactiva el anterior", () => {
  assert.match(logistics, /oldBarcode !== normalizedIdentifier\(barcode\)/);
  assert.match(logistics, /UPDATE logistics_item_identifiers SET active=FALSE/);
  assert.match(logistics, /itemUomId: presentation\.id/);
});

test("la lectura prioriza el registro y la interfaz explica la validación", () => {
  assert.match(logistics, /FROM logistics_item_identifiers/);
  assert.match(logistics, /item\.id=\$3::uuid/);
  assert.match(app, /GTIN \/ EAN \/ UPC/);
  assert.match(app, /dígito verificador GS1/);
  assert.match(app, /GTIN, EAN, UPC o código interno/);
});
