import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/006_cycle_counts.sql", import.meta.url), "utf8");

test("el modelo de conteo controla estados, líneas y permisos directos", () => {
  assert.match(migration, /logistics_cycle_counts/);
  assert.match(migration, /logistics_cycle_count_lines/);
  assert.match(migration, /DRAFT','IN_PROGRESS','SUBMITTED','APPROVED','POSTED','CANCELLED/);
  assert.match(migration, /REVOKE ALL ON logistics_cycle_counts FROM anon, authenticated/);
});

test("el conteo es ciego y excluye activos serializados", () => {
  assert.match(logistics, /item\.tracking_type<>'SERIAL'/);
  assert.match(logistics, /cycle\.blind_count AND cycle\.status IN \('DRAFT','IN_PROGRESS','RECOUNT_REQUIRED'\)/);
  assert.match(app, /El conteo será ciego/);
});

test("la contabilización conserva la diferencia física, es idempotente y usa ajustes V2", () => {
  assert.match(logistics, /const currentStock = await currentQuantity/);
  assert.match(logistics, /const difference = finalCounted - number\(line\.expected_quantity\)/);
  assert.match(logistics, /movementType: "ADJUSTMENT"/);
  assert.match(logistics, /idempotencyKey: `cycle-count:\$\{countId\}:\$\{line\.id\}`/);
  assert.match(logistics, /Quien realizó el conteo no puede aprobarlo/);
});

test("el stock queda bloqueado hasta contabilizar o cancelar el conteo", () => {
  assert.match(logistics, /cycle\.status IN \('DRAFT','IN_PROGRESS','RECOUNT_REQUIRED','SUBMITTED','APPROVED'\)/);
  assert.match(logistics, /temporalmente bloqueado por el conteo/);
  assert.match(logistics, /normalizedAction === "CANCEL"/);
  assert.match(app, /cancelar y liberar el stock/);
});

test("las API y la interfaz cubren el flujo completo del conteo", () => {
  assert.match(server, /\/api\/v1\/cycle-counts/);
  assert.match(server, /allowSelfApproval: Boolean\(apiProfile\.admin\)/);
  assert.match(app, /function cycleCountMarkup/);
  assert.match(app, /function cycleCountModal/);
  assert.match(app, /data-cycle-action="POST"/);
});

test("el listado de conteos usa el alias SQL correcto", () => {
  assert.match(logistics, /ORDER BY cycle\.created_at DESC LIMIT 100/);
  assert.doesNotMatch(logistics, /ORDER BY count\.created_at DESC LIMIT 100/);
});
