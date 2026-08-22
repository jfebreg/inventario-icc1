import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/060_inspection_template_governance.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("las versiones pasan por borrador y aprobación independiente", () => {
  assert.match(migration, /approval_mode IN \('PENDING','MANUAL','LEGACY'\)/);
  assert.match(migration, /NEW\.approved_by=NEW\.created_by/);
  assert.match(migration, /logistics_inspection_template_one_active_idx/);
  assert.match(migration, /logistics_inspection_template_events_no_change/);
});

test("el servicio conserva huella y auditoría de cada publicación", () => {
  assert.match(logistics, /createInspectionTemplateDraft/);
  assert.match(logistics, /approveInspectionTemplate/);
  assert.match(logistics, /definition_sha256/);
  assert.match(logistics, /INSPECTION_TEMPLATE_APPROVED/);
  assert.match(logistics, /El autor no puede aprobar su propia plantilla/);
});

test("una inspección sólo usa la versión activa y nunca crea otra automáticamente", () => {
  const start = logistics.indexOf("export async function createInspectionRun");
  const end = logistics.indexOf("export async function updateInspectionRun", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /status='ACTIVE'/);
  assert.match(implementation, /no coincide con la versión aprobada/);
  assert.doesNotMatch(implementation, /INSERT INTO logistics_inspection_template_versions/);
  assert.doesNotMatch(implementation, /SET status='RETIRED'/);
});

test("la API y la interfaz exponen borradores y publicación controlada", () => {
  assert.match(server, /\/api\/v1\/inspection-templates/);
  assert.match(server, /approveInspectionTemplate/);
  assert.match(app, /Formularios controlados/);
  assert.match(app, /Guardar borrador/);
  assert.match(app, /data-approve-inspection-template/);
});
