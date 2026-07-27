import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/026_logistics_kpi_snapshots.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("los cierres diarios de KPI son persistentes y no se duplican", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_kpi_snapshots/);
  assert.match(migration, /UNIQUE NULLS NOT DISTINCT/);
  assert.match(migration, /period_days INTEGER/);
  assert.match(migration, /metrics JSONB/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("los indicadores respetan período y alcance del centro", () => {
  assert.match(logistics, /export async function listLogisticsKpis/);
  assert.match(logistics, /Math\.max\(1, Math\.min\(730/);
  assert.match(logistics, /request_center\.name=\$3 OR fulfillment_center\.name=\$3/);
  assert.match(logistics, /center_name\.name=\$3/);
});

test("calcula servicio, puntualidad y tiempos de ciclo desde solicitudes", () => {
  assert.match(logistics, /AS fill_rate/);
  assert.match(logistics, /AS on_time_rate/);
  assert.match(logistics, /AS average_cycle_hours/);
  assert.match(logistics, /AS average_pick_hours/);
  assert.match(logistics, /overdue_open_requests/);
});

test("calcula exactitud de picking e inventario desde evidencia auditable", () => {
  assert.match(logistics, /PICK_TASK_EXCEPTION/);
  assert.match(logistics, /handled_tasks/);
  assert.match(logistics, /counted_quantity-line\.expected_quantity/);
  assert.match(logistics, /pickingAccuracy/);
  assert.match(logistics, /inventoryAccuracy/);
});

test("guardar un cierre crea snapshots por organización y bodega", () => {
  assert.match(logistics, /export async function snapshotLogisticsKpis/);
  assert.match(logistics, /LOGISTICS_KPI_SNAPSHOT/);
  assert.match(logistics, /ON CONFLICT \(organization_id,warehouse_id,period_days,snapshot_date\)/);
  assert.match(server, /logistics-kpis\/snapshot/);
});

test("el panel permite comparar períodos y muestra metas operativas", () => {
  assert.match(app, /function logisticsKpiMarkup/);
  assert.match(app, /data-kpi-days="30"/);
  assert.match(app, /data-kpi-days="365"/);
  assert.match(app, /Nivel de servicio/);
  assert.match(app, /Exactitud de picking/);
  assert.match(app, /Exactitud de inventario/);
});
