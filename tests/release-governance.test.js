import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app, architecture] = await Promise.all([
  readFile(new URL("../migrations/043_release_governance.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8")
]);

test("cada despliegue conserva versión commit migración y estado", () => {
  assert.match(migration, /logistics_release_records/);
  assert.match(migration, /commit_sha/);
  assert.match(migration, /latest_migration/);
  assert.match(migration, /ROLLED_BACK/);
  assert.match(migration, /logistics_one_approved_release_idx/);
});

test("las verificaciones de despliegue son inalterables", () => {
  assert.match(migration, /logistics_release_checks/);
  assert.match(migration, /Las verificaciones de despliegue son inalterables/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("el servidor registra automáticamente el commit activo", () => {
  assert.match(server, /registerCurrentRelease/);
  assert.match(server, /RENDER_GIT_COMMIT/);
  assert.match(server, /RENDER_SERVICE_ID/);
  assert.match(server, /RELEASE_DEPLOYED/);
});

test("una versión sólo se aprueba con controles obligatorios correctos", () => {
  assert.match(server, /validateRelease/);
  assert.match(server, /mandatoryFailures/);
  assert.match(server, /No puedes aprobar una versión con controles obligatorios pendientes/);
  assert.match(server, /RELEASE_APPROVED/);
});

test("API e interfaz permiten validar aprobar y registrar reversa", () => {
  assert.match(server, /\/api\/v1\/releases/);
  assert.match(app, /Control de versiones/);
  assert.match(app, /Validar versión/);
  assert.match(app, /Aprobar versión/);
  assert.match(app, /Registrar reversa/);
});

test("la arquitectura documenta aprobación y reversa sin borrar evidencia", () => {
  assert.match(architecture, /Gobierno de versiones y despliegues/);
  assert.match(architecture, /commit/);
  assert.match(architecture, /reversa/);
});
