import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, authClient, app] = await Promise.all([
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase-auth.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("las mutaciones administrativas exigen autenticación reciente", () => {
  assert.match(server, /AUTH_CRITICAL_REAUTH_MINUTES/);
  assert.match(server, /requiresRecentAuthentication/);
  assert.match(server, /hasRecentAuthentication/);
  assert.match(server, /REAUTH_REQUIRED/);
  assert.match(server, /last_sign_in_at/);
});

test("las consultas normales no fuerzan una nueva identificación", () => {
  assert.match(server, /if \(String\(method \|\| "GET"\)\.toUpperCase\(\) === "GET"\) return false/);
  assert.match(server, /pathname\.startsWith\("\/api\/admin\/"\)/);
});

test("el navegador cierra la sesión y explica la autenticación reforzada", () => {
  assert.match(authClient, /response\.clone\(\)\.json/);
  assert.match(authClient, /icc-reauth-required/);
  assert.match(authClient, /await logout\(\)/);
  assert.match(app, /icc-reauth-required/);
});
