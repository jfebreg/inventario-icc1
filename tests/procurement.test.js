import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/015_procurement_three_way_match.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el modelo separa orden, líneas, factura y tolerancias", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_procurement_settings/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_purchase_orders/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_purchase_order_lines/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_supplier_invoices/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_supplier_invoice_lines/);
});

test("una orden nace desde solicitud aprobada y mantiene costos e impuestos", () => {
  assert.match(logistics, /export async function createPurchaseOrder/);
  assert.match(logistics, /status='APPROVED' FOR UPDATE/);
  assert.match(logistics, /lineSubtotal = Number\(\(quantity \* unitCost\)/);
  assert.match(logistics, /PURCHASE_ORDER_CREATED/);
});

test("la recepción actualiza cantidades pendientes de la orden", () => {
  assert.match(logistics, /purchaseOrderLine\.quantity_ordered/);
  assert.match(logistics, /quantity_received=quantity_received\+\$1/);
  assert.match(logistics, /PARTIALLY_RECEIVED/);
  assert.match(logistics, /purchase_order_line_id/);
  assert.match(logistics, /La política de compras exige seleccionar una orden de compra emitida/);
  assert.match(server, /allowNoPurchaseOrder: Boolean\(apiProfile\.admin/);
});

test("la factura aplica conciliación de precio y cantidad recibida", () => {
  assert.match(logistics, /priceVariancePercent/);
  assert.match(logistics, /quantity_tolerance_percent/);
  assert.match(logistics, /type: "PRICE"/);
  assert.match(logistics, /type: "QUANTITY"/);
  assert.match(logistics, /type: "AMOUNT"/);
  assert.match(logistics, /status = allExceptions\.length \? "EXCEPTION" : "MATCHED"/);
});

test("las excepciones requieren aprobación independiente y fundamento", () => {
  assert.match(logistics, /Quien registra la factura no puede aprobarla/);
  assert.match(logistics, /La excepción requiere autorización administrativa y fundamento/);
  assert.match(server, /allowException: Boolean\(apiProfile\.admin\)/);
  assert.match(server, /syncSupplierInvoiceTask/);
});

test("API e interfaz cubren orden, recepción, factura y tolerancias", () => {
  assert.match(server, /\/api\/v1\/purchase-orders/);
  assert.match(server, /\/api\/v1\/supplier-invoices/);
  assert.match(server, /\/api\/v1\/procurement\/settings/);
  assert.match(app, /function procurementV2Markup/);
  assert.match(app, /id="purchaseOrderForm"/);
  assert.match(app, /id="supplierInvoiceForm"/);
  assert.match(app, /Orden cargada: proveedor, bodega, producto, cantidad y costo/);
});
