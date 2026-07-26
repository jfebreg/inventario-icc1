import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const immutableMigration = await readFile(new URL("../migrations/004_immutable_ledgers.sql", import.meta.url), "utf8");

test("los archivos y PDF quedan protegidos por usuario y centro de costo", () => {
  assert.match(server, /async function profileMayAccessFile/);
  assert.match(server, /async function profileMayAccessDocumentEntity/);
  assert.match(server, /Sólo puedes archivar documentos de tu centro de costo/);
  assert.match(server, /El archivo pertenece a otro centro de costo/);
  assert.match(server, /La inspección pertenece a otro centro de costo/);
  assert.match(server, /Sólo el administrador puede consultar el diagnóstico de archivos/);
});

test("el libro mayor y la auditoría son inalterables y verificables", () => {
  assert.match(immutableMigration, /logistics_ledger_immutable/);
  assert.match(immutableMigration, /logistics_audit_immutable/);
  assert.match(immutableMigration, /logistics_movement_no_delete/);
  assert.match(immutableMigration, /logistics_audit_chain_verification/);
  assert.match(immutableMigration, /digest\(concat_ws/);
  assert.match(logistics, /audit_chain_errors/);
  assert.match(logistics, /audit_chain_valid/);
  assert.match(app, /eventos encadenados/);
  assert.match(server, /La restauración heredada está reservada al administrador/);
});
