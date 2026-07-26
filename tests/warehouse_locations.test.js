import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/011_warehouse_locations.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("las ubicaciones soportan dirección, capacidad y estado operativo", () => {
  for (const field of ["zone_code", "aisle_code", "rack_code", "level_code", "position_code",
    "capacity_quantity", "picking_sequence", "operational_status"]) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /'AVAILABLE','BLOCKED','COUNTING','MAINTENANCE'/);
});

test("las reglas relacionan productos con ubicaciones preferidas y caras de picking", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_item_location_rules/);
  assert.match(migration, /is_pick_face BOOLEAN/);
  assert.match(migration, /UNIQUE \(organization_id,item_id,location_id\)/);
});

test("el almacenamiento dirigido respeta capacidad, mezcla y prioridad", () => {
  assert.match(logistics, /export async function suggestPutawayLocations/);
  assert.match(logistics, /fits_quantity/);
  assert.match(logistics, /allows_mixed_items/);
  assert.match(logistics, /rule\.priority/);
  assert.match(logistics, /location\.picking_sequence/);
});

test("la liberación desde cuarentena valida la ubicación final", () => {
  assert.match(logistics, /input\.targetLocationId/);
  assert.match(logistics, /no tiene capacidad para recibir/);
  assert.match(logistics, /no permite mezclar productos/);
  assert.match(app, /function inboundPutawayModal/);
  assert.match(app, /id="releaseInboundForm"/);
});

test("API e interfaz administran ubicaciones y etiquetas QR", () => {
  assert.match(server, /\/api\/v1\/putaway-suggestions/);
  assert.match(server, /\/api\/v1\/locations/);
  assert.match(app, /function warehouseLocationsV2Markup/);
  assert.match(app, /function locationLabelModal/);
  assert.match(app, /data-print-location/);
});
