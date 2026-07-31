import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const guide = await readFile(new URL("../GUIA_PUBLICACION.md", import.meta.url), "utf8");

test("la sonda de vida no depende de servicios externos", () => {
  assert.match(server, /url\.pathname === "\/api\/health\/live"/);
  assert.match(server, /status: "alive"/);
  assert.match(server, /process\.uptime\(\)/);
});

test("la disponibilidad exige base de datos y modelo logistico preparados", () => {
  assert.match(server, /async function readinessSnapshot/);
  assert.match(server, /query_timeout: 3000/);
  assert.match(server, /checks\.database\.ok && checks\.logistics\.ok/);
  assert.match(server, /readiness\.ready \? 200 : 503/);
  assert.match(server, /status: readiness\.ready \? "ready" : "not_ready"/);
});

test("la guia indica la ruta correcta para Render", () => {
  assert.match(guide, /\/api\/health\/ready/);
  assert.match(guide, /Health Check Path/);
});
