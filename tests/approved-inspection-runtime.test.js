import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("el servidor resuelve sólo el formulario aprobado vigente de la unidad", () => {
  const start = logistics.indexOf("export async function resolveApprovedInspectionTemplate");
  const end = logistics.indexOf("export async function createInspectionTemplateDraft", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /required_template_key/);
  assert.match(implementation, /status='ACTIVE'/);
  assert.match(implementation, /effective_from<=CURRENT_DATE/);
  assert.match(server, /inspection-templates\/resolve/);
});

test("el móvil muestra los ítems publicados y conserva su versión", () => {
  const start = app.indexOf("async function inspectionModal");
  const end = app.indexOf("function deadlineModal", start);
  const implementation = app.slice(start, end);
  assert.match(implementation, /template\.items/);
  assert.match(implementation, /templateVersionId/);
  assert.match(implementation, /name="key-/);
  assert.doesNotMatch(implementation, /let rows=\['Etiqueta o marcaje legible/);
});

test("el registro rechaza una versión que dejó de estar vigente", () => {
  const start = logistics.indexOf("export async function createInspectionRun");
  const end = logistics.indexOf("export async function updateInspectionRun", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /input\.templateVersionId/);
  assert.match(implementation, /formulario fue actualizado mientras completabas la inspección/i);
  assert.match(app, /templateVersionId:inspection\.templateVersionId/);
});
