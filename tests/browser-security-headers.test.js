import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("todas las respuestas reciben encabezados defensivos", () => {
  assert.match(server, /applyBrowserSecurityHeaders\(res\)/);
  assert.match(server, /Content-Security-Policy/);
  assert.match(server, /Strict-Transport-Security/);
  assert.match(server, /X-Content-Type-Options/);
  assert.match(server, /X-Frame-Options/);
  assert.match(server, /Referrer-Policy/);
  assert.match(server, /Permissions-Policy/);
});

test("la política permite Supabase y cámara sin habilitar contenido arbitrario", () => {
  assert.match(server, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  assert.match(server, /camera=\(self\)/);
  assert.match(server, /object-src 'none'/);
  assert.match(server, /frame-ancestors 'none'/);
  assert.doesNotMatch(server, /script-src[^\n]*unsafe-inline/);
});

test("los archivos de aplicación se revalidan después de cada despliegue", () => {
  assert.match(server, /\["\.html", "\.js", "\.css"\]\.includes\(extension\)/);
  assert.match(server, /headers\["Cache-Control"\] = "no-cache"/);
  assert.match(server, /"Cache-Control": "no-store"/);
});
