import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/027_logistics_kpi_targets.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("las metas se configuran por organización o bodega", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_kpi_targets/);
  assert.match(migration, /warehouse_id UUID REFERENCES logistics_warehouses/);
  assert.match(migration, /UNIQUE NULLS NOT DISTINCT/);
  assert.match(migration, /direction IN \('MINIMUM','MAXIMUM'\)/);
});

test("la migración incorpora metas iniciales de servicio y exactitud", () => {
  assert.match(migration, /'FILL_RATE','MINIMUM',95,90,80/);
  assert.match(migration, /'PICKING_ACCURACY','MINIMUM',99,97,95/);
  assert.match(migration, /'INVENTORY_ACCURACY','MINIMUM',97,95,90/);
  assert.match(migration, /'AVERAGE_CYCLE_HOURS','MAXIMUM',24,48,72/);
});

test("la configuración valida el orden de objetivo, alerta y crítico", () => {
  assert.match(logistics, /export async function upsertKpiTarget/);
  assert.match(logistics, /targetValue >= warningValue && warningValue >= criticalValue/);
  assert.match(logistics, /targetValue <= warningValue && warningValue <= criticalValue/);
  assert.match(logistics, /LOGISTICS_KPI_TARGET_UPDATED/);
});

test("la evaluación hereda metas generales y respeta metas por bodega", () => {
  assert.match(logistics, /function evaluateKpiTargets/);
  assert.match(logistics, /warehouseTargets\.get/);
  assert.match(logistics, /\|\| globalTargets\.get/);
  assert.match(logistics, /function kpiSeverity/);
});

test("cada cierre genera o resuelve tareas y notificaciones de desviación", () => {
  assert.match(logistics, /task_type='KPI_DEVIATION'/);
  assert.match(logistics, /status='Resuelta'/);
  assert.match(logistics, /INSERT INTO inventory_tasks/);
  assert.match(logistics, /INSERT INTO inventory_notifications/);
  assert.match(logistics, /ON CONFLICT \(id\) DO NOTHING/);
});

test("API e interfaz permiten administrar metas", () => {
  assert.match(server, /logistics-kpi-targets/);
  assert.match(server, /Sólo administración puede modificar metas logísticas/);
  assert.match(app, /function kpiTargetsModal/);
  assert.match(app, /id="kpiTargetForm"/);
  assert.match(app, /data-kpi-targets/);
  assert.match(app, /desviación\(es\) activa\(s\)/);
});
