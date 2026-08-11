import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/046_personal_data_governance.sql", import.meta.url), "utf8");

test("cada descarga autorizada registra usuario, propósito y documento", () => {
  assert.match(server, /async function recordFileAccess/);
  assert.match(server, /INSERT INTO logistics_personal_data_access_log/);
  assert.match(server, /Descarga administrativa de evidencia/);
  assert.match(server, /Consulta operativa autorizada/);
  assert.ok((server.match(/await recordFileAccess\(apiProfile, row, requestId\)/g) || []).length >= 2);
});

test("el registro relaciona la evidencia sin guardar IP ni credenciales", () => {
  assert.match(server, /logistics_document_links/);
  assert.match(server, /subject_reference/);
  assert.match(server, /asJson\(\{ requestId, center:/);
  const helper = server.slice(server.indexOf("async function recordFileAccess"), server.indexOf("async function readEvidenceBody"));
  assert.doesNotMatch(helper, /remoteAddress|x-forwarded-for|authorization/i);
});

test("firmas, EPP, inspecciones y trabajadores tienen categoría diferenciada", () => {
  assert.match(server, /function personalDataCategoryForFile/);
  for (const category of ["SIGNATURE", "PPE_EVIDENCE", "INSPECTION_EVIDENCE", "WORKER_RECORD", "DOCUMENT"]) {
    assert.match(server, new RegExp(`"${category}"`));
  }
  assert.match(migration, /logistics_personal_data_access_immutable/);
});
