import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

test("la configuración pública informa la disponibilidad de Auth sin publicar secretos privados", () => {
  assert.match(server, /serviceRoleConfigured/);
  assert.match(server, /publishableKeyConfigured/);
  assert.match(server, /bootstrapTokenConfigured/);
  assert.match(server, /appBaseUrlConfigured/);
  assert.doesNotMatch(server, /serviceRoleKey\s*:/);
  assert.doesNotMatch(server, /bootstrapToken\s*:/);
});

test("Configuración muestra el diagnóstico y permite iniciar la activación segura", () => {
  assert.match(app, /Acceso seguro con Supabase Auth/);
  assert.match(app, /SUPABASE_PUBLISHABLE_KEY/);
  assert.match(app, /data-open-auth-activation/);
  assert.match(app, /data-refresh-auth-activation/);
  assert.match(app, /Diagnóstico de acceso actualizado/);
});
