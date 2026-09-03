import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8");

test("las métricas se calculan en una ventana móvil configurable", () => {
  assert.match(server, /occurred_at>=NOW\(\)-\(\$2::int\*INTERVAL '1 day'\)/);
  assert.match(server, /COUNT\(\*\) FILTER \(WHERE event_type='SUCCESS'\)/);
  assert.match(server, /AVG\(duration_ms\)/);
  assert.match(server, /result->>'recovered'='true'/);
});

test("los incidentes abiertos y escalados provienen de tareas del servidor", () => {
  assert.match(server, /JOIN logistics_scheduled_jobs job ON job\.id::text=task\.entity_id/);
  assert.match(server, /payload->>'escalatedAt'/);
  assert.match(server, /openIncidents/);
  assert.match(server, /escalatedIncidents/);
});

test("el servidor entrega tasa de éxito y duración promedio", () => {
  assert.match(server, /const successRate = totalExecutions/);
  assert.match(server, /averageDurationMs/);
  assert.match(server, /automationHealth/);
});

test("Configuración presenta indicadores de confiabilidad", () => {
  assert.match(app, /Confiabilidad últimos \$\{h\.windowDays\|\|30\} días/);
  assert.match(app, /Tasa de éxito/);
  assert.match(app, /Incidentes abiertos/);
  assert.match(architecture, /ventana móvil de treinta días/);
});
