import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app] = await Promise.all([
  readFile(new URL("../migrations/047_privacy_incident_response.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo conserva incidentes y eventos inalterables", () => {
  assert.match(migration, /logistics_privacy_incidents/);
  assert.match(migration, /logistics_privacy_incident_events/);
  assert.match(migration, /DETECTED','ASSESSING','CONTAINED','NOTIFICATION_DECIDED','CLOSED/);
  assert.match(migration, /logistics_privacy_incident_events_immutable/);
});

test("la API controla evaluación, contención, notificación y cierre", () => {
  assert.match(server, /\/api\/admin\/privacy-incidents/);
  assert.match(server, /action === "ASSESS"/);
  assert.match(server, /action === "CONTAIN"/);
  assert.match(server, /action === "DECIDE_NOTIFICATION"/);
  assert.match(server, /Registra la decisión de notificación antes de cerrar/);
  assert.match(server, /privacy-incident-\$\{incident\.id\}/);
});

test("la interfaz integra incidentes en el panel de privacidad", () => {
  assert.match(app, /Incidentes de privacidad/);
  assert.match(app, /data-new-privacy-incident/);
  assert.match(app, /data-privacy-incident-action/);
  assert.match(app, /Evaluar → contener → decidir la notificación/);
});
