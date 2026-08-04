import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("el servidor distingue JSON invalido, formato incorrecto y exceso de tamaño", () => {
  assert.match(server, /class HttpRequestError extends Error/);
  assert.match(server, /PAYLOAD_TOO_LARGE/);
  assert.match(server, /JSON_CONTENT_TYPE_REQUIRED/);
  assert.match(server, /INVALID_JSON/);
  assert.match(server, /JSON_OBJECT_REQUIRED/);
  assert.match(server, /safeStatus/);
});

test("el tamaño declarado se rechaza antes de acumular el archivo en memoria", () => {
  const lengthCheck = server.indexOf('req.headers["content-length"]');
  const chunkLoop = server.indexOf("for await (const chunk of req)");
  assert.ok(lengthCheck > 0);
  assert.ok(chunkLoop > lengthCheck);
  assert.match(server, /Máximo permitido: 15 MB/);
});

test("estructuras excesivamente profundas o extensas se bloquean", () => {
  assert.match(server, /function validateJsonComplexity/);
  assert.match(server, /nodes > 20_000/);
  assert.match(server, /current\.depth > 50/);
  assert.match(server, /JSON_TOO_COMPLEX/);
  assert.match(server, /JSON_TOO_DEEP/);
});
