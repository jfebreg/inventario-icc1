import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [logistics, server, app] = await Promise.all([
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("un SKU nuevo se compara antes de abrir la transacción de alta", () => {
  const check = logistics.indexOf("const existingSku = await pool.query");
  const begin = logistics.indexOf('await client.query("BEGIN")', check);
  assert.ok(check > 0);
  assert.ok(begin > check);
  assert.match(logistics, /similarity\(LOWER\(item\.name\),LOWER\(\$2\)\)>=0\.78/);
});

test("agregar unidades a un SKU existente no activa un falso bloqueo", () => {
  assert.match(logistics, /const duplicateCandidates = existingSku\.rowCount \? \[\]/);
  assert.match(logistics, /UPPER\(item\.sku\)<>UPPER\(\$4\)/);
});

test("la coincidencia bloquea el alta y entrega candidatos explicables", () => {
  assert.match(logistics, /error\.code = "POSSIBLE_DUPLICATE"/);
  assert.match(logistics, /error\.candidates = duplicateCandidates/);
  assert.match(server, /code: possibleDuplicate \? "POSSIBLE_DUPLICATE"/);
  assert.match(server, /candidates: possibleDuplicate \? error\.candidates/);
});

test("sólo administración puede autorizar una excepción", () => {
  assert.match(server, /canOverrideDuplicate: Boolean\(apiProfile\.admin\)/);
  assert.match(logistics, /duplicateOverride && !input\.canOverrideDuplicate/);
  assert.match(logistics, /Sólo administración puede autorizar un código posiblemente duplicado/);
});

test("la excepción exige fundamento y queda en auditoría", () => {
  assert.match(logistics, /duplicateOverrideReason\.length < 10/);
  assert.match(logistics, /ITEM_DUPLICATE_OVERRIDE/);
  assert.match(logistics, /item\.duplicate\.override/);
  assert.match(logistics, /candidates: duplicateCandidates/);
});

test("el formulario muestra la excepción sólo al administrador", () => {
  assert.match(app, /assetDuplicateOverride/);
  assert.match(app, /function tuneDuplicateOverrideFields/);
  assert.match(app, /La autorización quedará asociada a tu usuario/);
  assert.match(app, /duplicateOverrideReason/);
});
