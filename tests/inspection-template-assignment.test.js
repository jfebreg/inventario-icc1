import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("familias serializadas sólo aceptan formularios publicados", () => {
  const start = logistics.indexOf("export async function registerItemFamily");
  const end = logistics.indexOf("export async function registerCanonicalDocument", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /Boolean\(input\.serial\).*inspectionTemplateKey/s);
  assert.match(implementation, /status='ACTIVE'/);
  assert.match(implementation, /effective_from<=CURRENT_DATE/);
  assert.match(app, /Formulario publicado<select name="inspection"/);
  assert.match(app, /Sin formulario \(sólo consumibles\)/);
});

test("cada plan selecciona explícitamente el formulario obligatorio", () => {
  const start = logistics.indexOf("export async function upsertInspectionPlan");
  const end = logistics.indexOf("export async function listInspectionPlans", start);
  const implementation = logistics.slice(start, end);
  assert.match(implementation, /approvedTemplate/);
  assert.match(implementation, /formulario aprobado y vigente/);
  assert.match(app, /name="requiredTemplateKey"/);
  assert.match(app, /requiredTemplateKey:d\.get\('requiredTemplateKey'\)/);
});

test("las listas administrativas excluyen borradores y versiones retiradas", () => {
  const start = app.indexOf("function activeInspectionTemplateOptions");
  const end = app.indexOf("function familyModal", start);
  assert.match(app.slice(start, end), /x\.status==='ACTIVE'/);
  assert.match(app, /inspectionTemplatesLoaded.*refreshInspectionTemplates/);
});
