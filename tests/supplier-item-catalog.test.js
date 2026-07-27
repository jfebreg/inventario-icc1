import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/022_supplier_item_catalog.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el catálogo vincula proveedor, artículo y presentación de compra", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_supplier_items/);
  assert.match(migration, /item_uom_id UUID REFERENCES logistics_item_uoms/);
  assert.match(migration, /lead_time_days INTEGER/);
  assert.match(migration, /minimum_order_quantity NUMERIC/);
  assert.match(migration, /order_multiple NUMERIC/);
});

test("sólo puede existir un proveedor preferente activo por artículo", () => {
  assert.match(migration, /logistics_supplier_items_preferred_idx/);
  assert.match(migration, /WHERE preferred AND active/);
  assert.match(logistics, /SET preferred=FALSE/);
});

test("el servicio valida alcance, presentación, moneda y cantidades", () => {
  assert.match(logistics, /export async function upsertSupplierItem/);
  assert.match(logistics, /La presentación de compra no corresponde al artículo/);
  assert.match(logistics, /código ISO de tres letras/);
  assert.match(logistics, /SUPPLIER_ITEM_REGISTERED/);
});

test("la API restringe la configuración al administrador", () => {
  assert.match(server, /\/api\/v1\/supplier-items/);
  assert.match(server, /Sólo el administrador puede configurar el catálogo de proveedores/);
  assert.match(server, /listSupplierItemCatalog/);
});

test("la interfaz permite consultar y editar el catálogo", () => {
  assert.match(app, /function supplierCatalogMarkup/);
  assert.match(app, /function supplierItemModal/);
  assert.match(app, /supplierItemForm/);
  assert.match(app, /Proveedor preferente para este artículo/);
});
