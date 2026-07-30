import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app, architecture] = await Promise.all([
  readFile(new URL("../migrations/040_access_governance.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8")
]);

test("los roles canónicos separan operación, inspección y aprobación", () => {
  assert.match(migration, /inventory_role_templates/);
  assert.match(migration, /WAREHOUSE_OPERATOR/);
  assert.match(migration, /CENTER_APPROVER/);
  assert.match(migration, /CENTER_MANAGER/);
  assert.match(migration, /can_initiate/);
  assert.match(migration, /can_approve/);
});

test("las revisiones y eventos de seguridad conservan historial inalterable", () => {
  assert.match(migration, /inventory_access_reviews/);
  assert.match(migration, /inventory_security_events/);
  assert.match(migration, /Los eventos de seguridad son inalterables/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("el servidor usa permisos cerrados y detecta conflictos de funciones", () => {
  assert.match(server, /const ROLE_PERMISSIONS/);
  assert.match(server, /function securityGovernanceOverview/);
  assert.match(server, /SOD_CONFLICT/);
  assert.match(server, /UNKNOWN_PERMISSION/);
  assert.match(server, /STALE_INVITATION/);
  assert.match(server, /security_version=security_version\+1/);
});

test("la revisión de acceso es administrativa, auditable y genera evento", () => {
  assert.match(server, /\/api\/admin\/security\/review/);
  assert.match(server, /\/api\/admin\/security/);
  assert.match(server, /ACCESS_REVIEW_COMPLETED/);
  assert.match(server, /inventory_security_events/);
  assert.match(server, /Sólo el administrador puede revisar accesos/);
});

test("la interfaz permite asignar roles separados y revisar accesos", () => {
  assert.match(app, /Aprobador centro de costo/);
  assert.match(app, /Operador de bodega/);
  assert.match(app, /function securityGovernanceMarkup/);
  assert.match(app, /data-review-access/);
  assert.match(app, /Separación de funciones/);
});

test("la arquitectura documenta mínimo privilegio y revisión periódica", () => {
  assert.match(architecture, /Gobierno de accesos/);
  assert.match(architecture, /mínimo privilegio/);
  assert.match(architecture, /separación entre operación y aprobación/);
});
