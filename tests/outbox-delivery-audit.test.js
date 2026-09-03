import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/068_outbox_delivery_attempts.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("cada intento queda individualizado sin almacenar el contenido del evento", () => {
  assert.match(migration, /logistics_outbox_delivery_attempts/);
  assert.match(migration, /UNIQUE \(outbox_event_id,attempt_number,channel\)/);
  assert.match(migration, /No almacena secretos ni el cuerpo completo/);
});

test("el despachador registra inicio entrega error y duración", () => {
  assert.match(logistics, /channel: "POSTGRES_NOTIFY", destination: "icc_logistics_events"/);
  assert.match(logistics, /VALUES \(\$1,\$2,\$3,\$4,\$5,'STARTED'\)/);
  assert.match(logistics, /status='DELIVERED'/);
  assert.match(logistics, /status='FAILED'/);
  assert.match(logistics, /duration_ms/);
  assert.match(logistics, /error_code/);
});

test("la supervisión expone métricas y bitácora reciente", () => {
  assert.match(logistics, /delivered_attempts_24h/);
  assert.match(logistics, /average_delivery_ms/);
  assert.match(logistics, /recentAttempts/);
  assert.match(app, /Bitácora de entregas recientes/);
  assert.match(app, /Promedio \$\{Number\(s\.average_delivery_ms/);
});
