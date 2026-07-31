import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("los errores inesperados se contienen y entregan un codigo de seguimiento", () => {
  assert.match(server, /handleHttpRequest\(req, res, requestId\)\.catch/);
  assert.match(server, /http_unhandled_error/);
  assert.match(server, /código de seguimiento/);
  assert.match(server, /requestId/);
});

test("cada solicitud operativa genera un registro estructurado", () => {
  assert.match(server, /type: "http_request"/);
  assert.match(server, /durationMs/);
  assert.match(server, /res\.once\("finish"/);
  assert.doesNotMatch(server, /searchParams\.toString\(\)/);
});

test("Render puede apagar el servicio sin cortar conexiones activas", () => {
  assert.match(server, /async function gracefulShutdown/);
  assert.match(server, /process\.once\("SIGTERM"/);
  assert.match(server, /server\.close/);
  assert.match(server, /await pool\.end\(\)/);
  assert.match(server, /server\.on\("clientError"/);
});
