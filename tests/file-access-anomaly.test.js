import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/049_file_access_anomaly_monitoring.sql", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../security-monitor.js", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("las alertas y sus eventos tienen gobierno e historial inalterable", () => {
  assert.match(migration, /logistics_file_access_alerts/);
  assert.match(migration, /logistics_file_access_alert_events/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL/);
});

test("el servidor detecta volumen sensible dentro de una ventana acotada", () => {
  assert.match(server, /async function monitorFileAccess/);
  assert.match(server, /INTERVAL '15 minutes'/);
  assert.match(server, /sensitiveCount < 10/);
  assert.match(server, /distinctCount < 15/);
  assert.match(server, /FILE_ACCESS_ANOMALY/);
  assert.match(server, /Acceso documental anómalo/);
});

test("la revisión exige fundamento y deriva accesos confirmados", () => {
  assert.match(server, /file-access-alerts/);
  assert.match(server, /La conclusión debe explicar/);
  assert.match(server, /privacy-followup-/);
  assert.match(server, /FILE_ACCESS_ALERT_REVIEWED/);
});

test("administración dispone de una bandeja separada de alertas", () => {
  assert.match(index, /security-monitor\.js/);
  assert.match(ui, /Alertas de acceso documental/);
  assert.match(ui, /data-file-alert-confirm/);
  assert.match(ui, /data-file-alert-dismiss/);
});
