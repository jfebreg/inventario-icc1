import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/016_supplier_returns_quality.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el modelo separa devolución y líneas vinculadas a la recepción", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_supplier_returns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_supplier_return_lines/);
  assert.match(migration, /UNIQUE \(receipt_id\)/);
  assert.match(migration, /return_movement_id UUID NOT NULL/);
});

test("rechazar exige motivo, descripción y contabiliza la salida", () => {
  assert.match(logistics, /allowedReasons/);
  assert.match(logistics, /Describe la no conformidad con al menos 10 caracteres/);
  assert.match(logistics, /INSERT INTO logistics_supplier_return_lines/);
  assert.match(logistics, /referenceType: normalizedAction === "RELEASE" \? "inbound_release" : "supplier_return"/);
});

test("la devolución reabre cantidades pendientes de la orden", () => {
  assert.match(logistics, /quantity_received=GREATEST\(0,quantity_received-\$1\)/);
  assert.match(logistics, /orderStatus = progress\.pending_lines === 0/);
});

test("entrega, nota de crédito y cierre quedan auditados", () => {
  assert.match(logistics, /export async function updateSupplierReturn/);
  assert.match(logistics, /CONFIRM_DELIVERY/);
  assert.match(logistics, /REGISTER_CREDIT/);
  assert.match(logistics, /SUPPLIER_RETURN_\$\{normalizedAction\}/);
  assert.match(server, /supplier-returns/);
  assert.match(server, /syncSupplierReturnTask/);
});

test("la interfaz captura no conformidad y seguimiento del proveedor", () => {
  assert.match(app, /function rejectInboundModal/);
  assert.match(app, /data-return-action="CONFIRM_DELIVERY"/);
  assert.match(app, /data-return-action="REGISTER_CREDIT"/);
  assert.match(app, /id="rejectInboundForm"/);
});
