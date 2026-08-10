import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/048_immutable_file_objects.sql", import.meta.url), "utf8");

test("el cliente nunca puede elegir ni reutilizar el identificador del archivo", () => {
  assert.match(server, /const id = `file-\$\{randomUUID\(\)\}`/);
  assert.doesNotMatch(server, /const id = body\.id/);
  assert.match(server, /"x-upsert": "false"/);
  assert.doesNotMatch(server, /ON CONFLICT \(id\) DO UPDATE SET filename/);
});

test("PostgreSQL bloquea sustituciones de contenido y huella", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION inventory_file_object_immutable/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON inventory_file_objects/);
  assert.match(migration, /NEW\.data_base64 IS DISTINCT FROM OLD\.data_base64/);
  assert.match(migration, /NEW\.payload ->> 'sha256'/);
  assert.match(migration, /contenido y la identidad del archivo son inmutables/);
});

test("la eliminación exige activar expresamente el proceso de disposición", () => {
  assert.match(migration, /icc\.allow_file_disposal/);
  assert.match(migration, /TG_OP = 'DELETE'/);
  assert.match(migration, /proceso autorizado de disposición documental/);
});
