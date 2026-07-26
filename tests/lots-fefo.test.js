import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, server, logistics, migration] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/007_lot_expiry_fefo.sql", import.meta.url), "utf8")
]);

test("el catálogo y los saldos mantienen lote, fabricación y vencimiento", () => {
  assert.match(logistics, /manufactured_at/);
  assert.match(logistics, /expires_at/);
  assert.match(logistics, /lot_number/);
  assert.match(logistics, /lot\.expires_at NULLS LAST/);
  assert.match(migration, /logistics_lots_expiry_idx/);
});

test("la recepción de lotes es transaccional e idempotente", () => {
  assert.match(logistics, /export async function receiveLot/);
  assert.match(logistics, /postMovementWithClient\(client/);
  assert.match(logistics, /lot\.received/);
  assert.match(server, /url\.pathname === "\/api\/v1\/lots\/receive"/);
  assert.match(server, /profileMayAccessLocation/);
});

test("FEFO excluye vencidos y divide traslados entre lotes", () => {
  assert.match(app, /function fefoAllocations/);
  assert.match(app, /expires_at\|\|'9999-12-31'/);
  assert.match(app, /String\(x\.expires_at\)\.slice\(0,10\)>=today/);
  assert.match(app, /lines=allocations\.map/);
  assert.match(app, /lotId:x\.lotId/);
});

test("la interfaz permite crear lotes y muestra alertas preventivas", () => {
  assert.match(app, /Controlar este consumible por lote y vencimiento/);
  assert.match(app, /function newLotModal/);
  assert.match(app, /id="newLotForm"/);
  assert.match(app, /Lotes y vencimientos/);
  assert.match(app, /Alertas a 60 días/);
});

test("las entregas a terreno conservan el lote utilizado", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS lot_id/);
  assert.match(logistics, /external_reference,lot_id/);
  assert.match(logistics, /lotId,/);
  assert.match(app, /Lote FEFO/);
});
