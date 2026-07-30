import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app] = await Promise.all([
  readFile(new URL("../migrations/046_personal_data_governance.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo registra tratamientos, solicitudes y accesos personales", () => {
  assert.match(migration, /logistics_privacy_activities/);
  assert.match(migration, /logistics_data_subject_requests/);
  assert.match(migration, /logistics_personal_data_access_log/);
  assert.match(migration, /ACCESS','CORRECTION','RESTRICTION','OBJECTION/);
  assert.match(migration, /logistics_personal_data_access_immutable/);
});

test("la API exige administración, verificación y respuesta fundada", () => {
  assert.match(server, /\/api\/admin\/privacy-governance/);
  assert.match(server, /\/api\/admin\/data-subject-requests/);
  assert.match(server, /Verifica la identidad antes de responder/);
  assert.match(server, /DATA_SUBJECT_REQUEST_UPDATED/);
  assert.match(server, /Sólo el administrador puede tramitar solicitudes/);
});

test("la interfaz tramita privacidad sin borrar evidencia logística", () => {
  assert.match(app, /Protección de datos personales/);
  assert.match(app, /data-new-data-request/);
  assert.match(app, /data-data-request-action/);
  assert.match(app, /No elimina movimientos, inspecciones, firmas ni documentos/);
  assert.match(app, /if\(route==='settings'\)\{renderAuthActivationCard\(\);if\(window\.ICCAuth\?\.configured\)/);
  assert.match(app, /renderDocumentGovernanceCard\(\);renderPrivacyGovernanceCard\(\)/);
});
