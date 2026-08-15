import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/055_inspection_segregation.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("PostgreSQL impide que inspector y aprobador sean la misma persona", () => {
  assert.match(migration, /logistics_inspection_run_separation/);
  assert.match(migration, /logistics_inspection_approval_separation/);
  assert.match(migration, /inspector_profile_id=NEW\.approver_profile_id/);
});

test("el servicio rechaza aprobación y verificación propias", () => {
  assert.match(logistics, /inspector no puede aprobar ni verificar su propia inspección/);
  assert.match(logistics, /current\.inspector_profile_id/);
});

test("la revisión de accesos detecta conflictos históricos", () => {
  assert.match(server, /INSPECTION_SELF_APPROVAL/);
  assert.match(server, /inspection\.inspector_profile_id=approval\.approver_profile_id/);
});

test("la interfaz avisa antes de enviar una autoaprobación", () => {
  assert.match(app, /Selecciona otro revisor/);
  assert.match(app, /inspection\?\.inspector/);
});
