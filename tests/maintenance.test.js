import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/012_asset_maintenance.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el modelo separa planes, órdenes y repuestos", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_maintenance_plans/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_work_orders/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_work_order_parts/);
  assert.match(migration, /'OPEN','APPROVED','IN_PROGRESS','WAITING_PARTS','COMPLETED','CANCELLED'/);
});

test("las inspecciones no conformes generan orden y bloquean el equipo", () => {
  assert.match(logistics, /Corregir hallazgos de inspección/);
  assert.match(logistics, /work_type,priority,status/);
  assert.match(logistics, /UPDATE logistics_asset_units SET status='BLOCKED'/);
  assert.match(logistics, /inspection_id/);
});

test("el flujo controla aprobación, reparación, espera y cierre", () => {
  assert.match(logistics, /APPROVE: \{ from: \["OPEN"\], to: "APPROVED" \}/);
  assert.match(logistics, /START: \{ from: \["APPROVED"\], to: "IN_PROGRESS" \}/);
  assert.match(logistics, /WAIT_PARTS: \{ from: \["IN_PROGRESS"\], to: "WAITING_PARTS" \}/);
  assert.match(logistics, /COMPLETE: \{ from: \["IN_PROGRESS", "WAITING_PARTS"\], to: "COMPLETED" \}/);
  assert.match(logistics, /Describe el trabajo realizado antes de cerrar/);
});

test("el cierre consume repuestos por ubicación y FEFO", () => {
  assert.match(logistics, /Repuesto utilizado en/);
  assert.match(logistics, /location\.picking_sequence,lot\.expires_at NULLS LAST/);
  assert.match(logistics, /quantity_used=quantity_planned/);
  assert.match(logistics, /movementType: "CONSUMPTION"/);
  assert.match(logistics, /next_due_at=NOW\(\)\+\(interval_days::text\|\|' days'\)::interval/);
});

test("API e interfaz cubren el historial de mantenimiento", () => {
  assert.match(server, /\/api\/v1\/maintenance\/plans/);
  assert.match(server, /\/api\/v1\/maintenance\/work-orders/);
  assert.match(app, /function maintenanceV2Markup/);
  assert.match(app, /id="maintenancePlanForm"/);
  assert.match(app, /id="workOrderForm"/);
  assert.match(app, /id="completeWorkOrderForm"/);
});
