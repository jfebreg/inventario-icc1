import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/029_logistics_outbox_delivery.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la cola distingue pendientes, proceso, reintento, entrega y descarte", () => {
  assert.match(migration, /PENDING','PROCESSING','RETRY','PUBLISHED','DEAD_LETTER/);
  assert.match(migration, /available_at TIMESTAMPTZ/);
  assert.match(migration, /logistics_outbox_delivery_idx/);
  assert.match(migration, /logistics_outbox_dead_letter_idx/);
});

test("el procesador reclama lotes sin bloquear otros trabajadores", () => {
  assert.match(logistics, /export async function processOutboxEvents/);
  assert.match(logistics, /pg_try_advisory_lock/);
  assert.match(logistics, /FOR UPDATE SKIP LOCKED/);
  assert.match(logistics, /status='PROCESSING'/);
  assert.match(logistics, /locked_at<NOW\(\)-INTERVAL '5 minutes'/);
});

test("publica una envolvente mínima y no expone el contenido completo", () => {
  assert.match(logistics, /icc_logistics_events/);
  assert.match(logistics, /eventType: event\.event_type/);
  assert.match(logistics, /aggregateId: event\.aggregate_id/);
  assert.doesNotMatch(logistics, /payload: event\.payload/);
});

test("los errores tienen espera progresiva y terminan en tarea crítica", () => {
  assert.match(logistics, /2 \*\* Math\.max/);
  assert.match(logistics, /DEAD_LETTER/);
  assert.match(logistics, /OUTBOX_FAILURE/);
  assert.match(logistics, /outbox-\$\{event\.id\}/);
  assert.match(logistics, /INSERT INTO inventory_notifications/);
});

test("el servidor procesa periódicamente y protege recuperación administrativa", () => {
  assert.match(server, /startLogisticsOutboxScheduler/);
  assert.match(server, /setInterval\(run, 60_000\)/);
  assert.match(server, /\/api\/v1\/outbox\/status/);
  assert.match(server, /\/api\/v1\/outbox\/process-now/);
  assert.match(server, /endsWith\("\/retry"\)/);
});

test("configuración muestra salud, fallos y reintentos", () => {
  assert.match(app, /function outboxMonitorMarkup/);
  assert.match(app, /Cola de eventos operativos/);
  assert.match(app, /data-process-outbox/);
  assert.match(app, /data-retry-outbox/);
});
