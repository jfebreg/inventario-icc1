import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("los archivos y PDF quedan protegidos por usuario y centro de costo", () => {
  assert.match(server, /async function profileMayAccessFile/);
  assert.match(server, /async function profileMayAccessDocumentEntity/);
  assert.match(server, /Sólo puedes archivar documentos de tu centro de costo/);
  assert.match(server, /El archivo pertenece a otro centro de costo/);
  assert.match(server, /La inspección pertenece a otro centro de costo/);
  assert.match(server, /Sólo el administrador puede consultar el diagnóstico de archivos/);
});
