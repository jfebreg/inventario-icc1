import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

function occurrences(text) {
  return app.split(text).length - 1;
}

test("cada formulario crítico tiene un solo controlador operativo", () => {
  assert.equal(occurrences("if(e.target.id!=='terrainForm')return"), 1);
  assert.equal(occurrences("if(e.target.id!=='inspectionForm')return;e.preventDefault();e.stopImmediatePropagation()"), 1);
  assert.equal(occurrences("if(e.target.id!=='newCenterForm')return;e.preventDefault();e.stopImmediatePropagation()"), 1);
});

test("no conserva el controlador general obsoleto", () => {
  assert.doesNotMatch(app, /\|\|Punto\s*,result/);
  assert.doesNotMatch(app, /if\(\['assetForm','inspectionForm','familyForm','userForm','centerForm','deadlineForm'\]\.includes/);
});

test("la evidencia de corrección mantiene su archivado", () => {
  assert.equal(occurrences("if(e.target.id!=='correctionForm')return;let d=new FormData"), 1);
  assert.match(app, /Levantamiento de observación/);
});
