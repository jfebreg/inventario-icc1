import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, server, logistics, migration] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/008_inbound_receiving.sql", import.meta.url), "utf8")
]);

test("el modelo separa proveedores, cabecera y líneas de recepción", () => {
  assert.match(migration, /logistics_suppliers/);
  assert.match(migration, /logistics_inbound_receipts/);
  assert.match(migration, /logistics_inbound_receipt_lines/);
  assert.match(migration, /UNIQUE \(organization_id, supplier_id, document_type, document_number\)/);
});

test("todas las bodegas disponen de una ubicación de cuarentena", () => {
  assert.match(migration, /location_type.*QUARANTINE/is);
  assert.match(migration, /ON CONFLICT \(organization_id, code\) DO UPDATE/);
  assert.match(logistics, /\["QUARANTINE", "Cuarentena"\]/);
  assert.match(logistics, /ubicación de cuarentena configurada/);
});

test("la recepción contabiliza stock bloqueado antes de liberar", () => {
  assert.match(logistics, /export async function createInboundReceipt/);
  assert.match(logistics, /toLocationId: quarantine\.id/);
  assert.match(logistics, /'QUARANTINE',\$7/);
  assert.match(logistics, /INBOUND_RECEIVED/);
  assert.match(logistics, /inbound\.quarantined/);
});

test("liberar mueve de cuarentena a almacenamiento sin reescribir el libro mayor", () => {
  assert.match(logistics, /export async function updateInboundReceipt/);
  assert.match(logistics, /fromLocationId: quarantine\.id/);
  assert.match(logistics, /toLocationId: storage\?\.id/);
  assert.match(logistics, /INBOUND_RELEASED/);
  assert.match(logistics, /inbound\.released/);
});

test("las API aplican permisos y alcance por bodega", () => {
  assert.match(server, /\/api\/v1\/suppliers/);
  assert.match(server, /\/api\/v1\/inbound-receipts/);
  assert.match(server, /profileMayAccessWarehouse/);
  assert.match(server, /action === "REJECT" \? "approve" : "receive"/);
});

test("la interfaz mantiene cuarentena fuera del stock utilizable", () => {
  assert.match(app, /function inboundV2Markup/);
  assert.match(app, /Recibir compra en cuarentena/);
  assert.match(app, /x\.location_type==='STORAGE'/);
  assert.match(app, /Stock bloqueado/);
  assert.match(app, /Liberación de recepción/);
});
