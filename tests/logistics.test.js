import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { logisticsValidation } from "../lib/logistics.js";

test("normaliza códigos operativos sin perder los dígitos", () => {
  assert.equal(logisticsValidation.slug("Bodega Central"), "BODEGA-CENTRAL");
  assert.equal(logisticsValidation.slug("IZA-000001"), "IZA-000001");
  assert.equal(logisticsValidation.slug("Obra Túnel"), "OBRA-TUNEL");
});

test("rechaza cantidades nulas, negativas o inválidas", () => {
  assert.equal(logisticsValidation.assertPositiveQuantity("2.5"), 2.5);
  assert.throws(() => logisticsValidation.assertPositiveQuantity(0), /mayor que cero/i);
  assert.throws(() => logisticsValidation.assertPositiveQuantity(-1), /mayor que cero/i);
  assert.throws(() => logisticsValidation.assertPositiveQuantity("no"), /mayor que cero/i);
});

test("sólo permite tipos de movimiento controlados", () => {
  assert.equal(logisticsValidation.assertMovementType("receipt"), "RECEIPT");
  assert.equal(logisticsValidation.assertMovementType("transfer_dispatch"), "TRANSFER_DISPATCH");
  assert.throws(() => logisticsValidation.assertMovementType("borrar stock"), /no permitido/i);
});

test("la clave de saldo es estable y cambia por unidad o ubicación", () => {
  const base = {
    organizationId: "org",
    itemId: "item",
    assetUnitId: null,
    lotId: null,
    locationId: "location-a"
  };
  const first = logisticsValidation.balanceKey(base);
  assert.equal(first, logisticsValidation.balanceKey({ ...base }));
  assert.notEqual(first, logisticsValidation.balanceKey({ ...base, locationId: "location-b" }));
  assert.notEqual(first, logisticsValidation.balanceKey({ ...base, assetUnitId: "unit-1" }));
});

test("la migración contiene las invariantes esenciales", async () => {
  const migration = await readFile(new URL("../migrations/001_logistics_core.sql", import.meta.url), "utf8");
  assert.match(migration, /logistics_stock_ledger/);
  assert.match(migration, /CHECK \(quantity <> 0\)/);
  assert.match(migration, /CHECK \(asset_unit_id IS NULL OR ABS\(quantity\) = 1\)/);
  assert.match(migration, /source_warehouse_id <> destination_warehouse_id/);
  assert.match(migration, /quantity_received <= quantity_dispatched/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});
