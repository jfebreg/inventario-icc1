import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app] = await Promise.all([
  readFile(new URL("../migrations/044_recovery_drills.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("las pruebas de recuperación conservan objetivos, resultados y evidencia", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_recovery_drills/);
  assert.match(migration, /target_rpo_minutes/);
  assert.match(migration, /target_rto_minutes/);
  assert.match(migration, /measured_rpo_minutes/);
  assert.match(migration, /measured_rto_minutes/);
  assert.match(migration, /evidence_file_id/);
  assert.match(migration, /corrective_actions/);
});

test("la API restringe y audita la planificación y cierre", () => {
  assert.match(server, /\/api\/admin\/recovery-drills/);
  assert.match(server, /RECOVERY_DRILL_PLANNED/);
  assert.match(server, /RECOVERY_DRILL_\$\{action\}/);
  assert.match(server, /Una prueba fallida requiere hallazgos y acciones correctivas/);
});

test("configuración permite registrar y revisar RPO y RTO", () => {
  assert.match(app, /data-recovery-drills/);
  assert.match(app, /Pruebas de recuperación RPO\/RTO/);
  assert.match(app, /completeRecoveryForm/);
  assert.match(app, /Nunca se restaura directamente sobre producción/);
});

test("verificar una exportación cierra automáticamente una prueba con evidencia", () => {
  assert.match(server, /'EXPORT_VERIFY','production-read-only'/);
  assert.match(server, /measuredRpoMinutes/);
  assert.match(server, /Validación no destructiva del paquete SHA-256/);
  assert.match(server, /Generar un nuevo respaldo V2 y repetir la verificación/);
});
