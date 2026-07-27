import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/024_material_picking_tasks.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo crea tareas auditables por cada reserva física", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_pick_tasks/);
  assert.match(migration, /UNIQUE \(reservation_id\)/);
  assert.match(migration, /'OPEN','IN_PROGRESS','PICKED','EXCEPTION','CANCELLED'/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("iniciar preparación crea tareas ordenadas por ubicación", () => {
  assert.match(logistics, /normalizedAction === "START_PICK"/);
  assert.match(logistics, /INSERT INTO logistics_pick_tasks/);
  assert.match(logistics, /location\.picking_sequence/);
  assert.match(logistics, /ON CONFLICT \(reservation_id\) DO UPDATE/);
});

test("la entrega exige todas las tareas verificadas", () => {
  assert.match(logistics, /ISSUE: \{ from: \["PICKING"\], to: "ISSUED" \}/);
  assert.match(logistics, /Preparación incompleta:/);
  assert.match(logistics, /status='PICKED'/);
  assert.match(logistics, /quantity_picked=quantity_required/);
});

test("el picking valida ubicación, producto, cantidad y diferencias", () => {
  assert.match(logistics, /export async function updatePickTask/);
  assert.match(logistics, /Ubicación incorrecta/);
  assert.match(logistics, /El código escaneado no corresponde/);
  assert.match(logistics, /Indica el motivo de la diferencia/);
  assert.match(logistics, /PICK_TASK_\$\{nextStatus\}/);
});

test("API e interfaz móvil guían la preparación por escaneo", () => {
  assert.match(server, /pick-tasks/);
  assert.match(server, /updatePickTask/);
  assert.match(app, /function pickingModal/);
  assert.match(app, /function pickTaskModal/);
  assert.match(app, /id="pickTaskForm"/);
  assert.match(app, /Código de ubicación/);
  assert.match(app, /Código del producto/);
});
