import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("el móvil presenta todos los tipos de respuesta admitidos por el modelo", () => {
  const start = app.indexOf("function configureInspectionResponseControls");
  const end = app.indexOf("function deadlineModal", start);
  const implementation = app.slice(start, end);
  for (const type of ["NUMBER", "TEXT", "DATE", "CHOICE", "BOOLEAN"]) {
    assert.match(implementation, new RegExp(type));
  }
  assert.match(implementation, /inputmode="decimal"/);
  assert.match(implementation, /item\.options/);
});

test("las alternativas pueden declarar su resultado sin inferencias peligrosas", () => {
  const start = logistics.indexOf("function normalizeInspectionAnswerResult");
  const end = logistics.indexOf("export async function createInspectionRun", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /selected\.result/);
  assert.match(implementation, /NON_COMPLIANT/);
  assert.match(implementation, /NOT_APPLICABLE/);
  assert.match(implementation, /return "COMPLIANT"/);
});

test("el respaldo local adopta el resultado canónico del servidor", () => {
  assert.match(app, /canonicalResult:result\.inspection\?\.result/);
  assert.match(app, /canonical\?\.canonicalResult==='NON_COMPLIANT'/);
});

test("administración configura cada punto sin escribir formatos técnicos", () => {
  assert.match(app, /function inspectionTemplateItemRow/);
  assert.match(app, /Lista de alternativas/);
  assert.match(app, /Respuesta no conforme/);
  assert.match(app, /Respuesta no aplicable/);
  assert.match(app, /function collectInspectionTemplateItems/);
  assert.match(app, /data-add-template-item/);
  assert.match(app, /data-remove-template-item/);
  assert.doesNotMatch(app, /String\(d\.get\('items'\)/);
});
