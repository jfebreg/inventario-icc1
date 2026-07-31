import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("cada solicitud recibe un identificador de trazabilidad", () => {
  assert.match(server, /randomUUID/);
  assert.match(server, /X-Request-Id/);
});

test("las mutaciones web rechazan solicitudes de sitios externos", () => {
  assert.match(server, /function requestOriginAllowed/);
  assert.match(server, /sec-fetch-site/);
  assert.match(server, /fetchSite === "cross-site"/);
  assert.match(server, /SOLICITUD_ORIGEN_INVALIDO/);
});

test("la aceptacion publica y las mutaciones tienen limites independientes", () => {
  assert.match(server, /consumeRequestRate\(req, "public-acceptance", 10, 15 \* 60 \* 1000\)/);
  assert.match(server, /consumeRequestRate\(req, "api-mutation", 180, 60 \* 1000\)/);
  assert.match(server, /RateLimit-Limit/);
  assert.match(server, /Retry-After/);
});
