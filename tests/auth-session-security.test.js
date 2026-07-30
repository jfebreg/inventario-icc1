import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, authClient, app] = await Promise.all([
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase-auth.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la duración inactiva es configurable y conserva un límite seguro", () => {
  assert.match(server, /AUTH_IDLE_MINUTES/);
  assert.match(server, /authIdleMinutes/);
  assert.match(server, /Math\.min\(480, Math\.max\(10/);
});

test("la sesión avisa, se cierra por inactividad y vuelve al acceso", () => {
  assert.match(authClient, /scheduleIdleTimers/);
  assert.match(authClient, /expireIdleSession/);
  assert.match(authClient, /icc-session-warning/);
  assert.match(authClient, /icc-session-expired/);
  assert.match(authClient, /signOut\(\{ scope: "local" \}\)/);
});

test("la actividad válida reinicia el temporizador sin usar movimiento del mouse", () => {
  assert.match(authClient, /\["pointerdown", "keydown", "touchstart"\]/);
  assert.match(authClient, /registerUserActivity/);
  assert.doesNotMatch(authClient, /mousemove.*registerUserActivity/);
});

test("la interfaz informa el cierre al usuario", () => {
  assert.match(app, /icc-session-expired/);
  assert.match(app, /icc-session-warning/);
});
