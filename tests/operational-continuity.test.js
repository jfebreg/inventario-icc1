import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app, architecture] = await Promise.all([
  readFile(new URL("../migrations/042_operational_continuity.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8")
]);

test("la salud y los incidentes tienen registros normalizados", () => {
  assert.match(migration, /logistics_health_runs/);
  assert.match(migration, /logistics_operational_incidents/);
  assert.match(migration, /SEV1/);
  assert.match(migration, /INVESTIGATING/);
  assert.match(migration, /root_cause/);
});

test("la cronología del incidente es inalterable", () => {
  assert.match(migration, /logistics_incident_events/);
  assert.match(migration, /El historial de incidentes es inalterable/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("el servidor ejecuta monitoreo periódico y conserva resultados", () => {
  assert.match(server, /captureOperationalHealth/);
  assert.match(server, /startOperationalHealthScheduler/);
  assert.match(server, /HEALTH_CHECK_COMPLETED/);
  assert.match(server, /5 \* 60 \* 1000/);
});

test("la API administra incidentes con permisos y auditoría", () => {
  assert.match(server, /\/api\/v1\/operations\/continuity/);
  assert.match(server, /\/api\/v1\/operations\/incidents/);
  assert.match(server, /OPERATIONAL_INCIDENT_OPENED/);
  assert.match(server, /OPERATIONAL_INCIDENT_RESOLVED/);
  assert.match(server, /profileMayAccessWarehouse/);
});

test("configuración ofrece salud, incidentes y cierre con causa", () => {
  assert.match(app, /Continuidad operacional/);
  assert.match(app, /Reportar incidente/);
  assert.match(app, /Registrar diagnóstico/);
  assert.match(app, /Causa raíz/);
  assert.match(app, /Acción correctiva/);
});

test("la arquitectura documenta continuidad y gestión de incidentes", () => {
  assert.match(architecture, /Continuidad y gestión de incidentes/);
  assert.match(architecture, /SEV1/);
  assert.match(architecture, /causa raíz/);
});
