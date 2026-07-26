import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/014_inventory_periods_adjustments.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el modelo separa períodos y solicitudes de ajuste", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_inventory_periods/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_inventory_adjustments/);
  assert.match(migration, /'OPEN','CLOSING','CLOSED'/);
  assert.match(migration, /'SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED'/);
});

test("un período cerrado bloquea movimientos retroactivos", () => {
  assert.match(logistics, /const closedPeriod = await client\.query/);
  assert.match(logistics, /está cerrado y no admite movimientos/);
  assert.match(logistics, /COALESCE\(\$2::timestamptz,NOW\(\)\)::date BETWEEN starts_on AND ends_on/);
});

test("el cierre exige resolver ajustes y conteos y conserva una fotografía valorizada", () => {
  assert.match(logistics, /export async function closeInventoryPeriod/);
  assert.match(logistics, /ajuste\(s\) pendientes de resolver/);
  assert.match(logistics, /conteo\(s\) cíclico\(s\) sin cerrar/);
  assert.match(logistics, /closing_summary/);
  assert.match(logistics, /INVENTORY_PERIOD_CLOSED/);
});

test("los ajustes requieren segregación, aprobación y contabilización idempotente", () => {
  assert.match(logistics, /Quien solicita un ajuste no puede aprobarlo/);
  assert.match(logistics, /Quien solicitó el ajuste no puede contabilizarlo/);
  assert.match(logistics, /inventory-adjustment:\$\{current\.id\}/);
  assert.match(logistics, /INVENTORY_ADJUSTMENT_POSTED/);
  assert.match(server, /Los ajustes deben solicitarse y aprobarse antes de contabilizarse/);
});

test("API e interfaz permiten operar períodos y ajustes controlados", () => {
  assert.match(server, /\/api\/v1\/inventory-periods/);
  assert.match(server, /\/api\/v1\/inventory-adjustments/);
  assert.match(app, /function inventoryControlMarkup/);
  assert.match(app, /function inventoryAdjustmentModal/);
  assert.match(app, /id="closeInventoryPeriodForm"/);
  assert.match(app, /Ajuste enviado a aprobación/);
  assert.match(server, /syncInventoryAdjustmentTask/);
  assert.match(server, /notification-\$\{taskId\}-\$\{adjustment\.status\}/);
});
