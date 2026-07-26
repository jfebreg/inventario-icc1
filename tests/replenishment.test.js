import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, server, logistics, migration] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/009_replenishment_planning.sql", import.meta.url), "utf8")
]);

test("las políticas se definen por producto y bodega", () => {
  assert.match(migration, /logistics_replenishment_policies/);
  assert.match(migration, /UNIQUE \(organization_id, item_id, warehouse_id\)/);
  assert.match(migration, /maximum_stock >= reorder_point/);
  assert.match(logistics, /export async function upsertReplenishmentPolicy/);
});

test("las sugerencias consideran disponible, cuarentena y compras en curso", () => {
  assert.match(logistics, /location_type='STORAGE'/);
  assert.match(logistics, /location_type='QUARANTINE'/);
  assert.match(logistics, /pending_quantity/);
  assert.match(logistics, /suggested_quantity/);
  assert.match(logistics, /PARTIALLY_RECEIVED/);
});

test("la solicitud sigue un flujo de aprobación controlado", () => {
  assert.match(migration, /DRAFT','SUBMITTED','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED/);
  assert.match(logistics, /export async function createPurchaseRequisition/);
  assert.match(logistics, /export async function updatePurchaseRequisition/);
  assert.match(logistics, /Quien solicitó la compra no puede aprobarla/);
});

test("la recepción puede cerrar cantidades de una solicitud aprobada", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS requisition_id/);
  assert.match(logistics, /quantity_received=LEAST/);
  assert.match(logistics, /pending\.rows\[0\]\.count \? "PARTIALLY_RECEIVED" : "RECEIVED"/);
  assert.match(app, /Solicitud aprobada \(opcional\)/);
});

test("API e interfaz cubren configuración, solicitud y aprobación", () => {
  assert.match(server, /\/api\/v1\/replenishment\/policies/);
  assert.match(server, /\/api\/v1\/purchase-requisitions/);
  assert.match(server, /allowSelfApproval: Boolean\(apiProfile\.admin\)/);
  assert.match(app, /function replenishmentV2Markup/);
  assert.match(app, /function replenishmentPolicyModal/);
  assert.match(app, /data-requisition-action="APPROVE"/);
});
