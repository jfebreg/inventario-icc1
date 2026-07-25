import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const auth = await readFile(new URL("../supabase-auth.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("el acceso temporal identifica el perfil ante la API", () => {
  assert.match(auth, /X-Legacy-User-Id/);
  assert.match(server, /requestLegacyProfile/);
  assert.match(server, /migration_complete/);
});

test("los movimientos usan V2 también durante la transición", () => {
  assert.match(app, /async function registerMovementV2[\s\S]*?if\(!activeUserId\)return null/);
  assert.doesNotMatch(app, /registerMovementV2[\s\S]{0,180}migrationComplete/);
});

test("el éxito espera el respaldo y vuelve a conciliar", () => {
  assert.match(app, /await persistState\(\);await loadLogisticsV2\(true\)/);
  assert.match(app, /Movimiento registrado y conciliado en el libro mayor/);
});

test("los adjuntos se descargan mediante la sesión autenticada", () => {
  assert.match(app, /async function downloadStoredFile/);
  assert.match(app, /a\[href\^="\/api\/files\/"\]/);
});
