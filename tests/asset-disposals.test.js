import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/017_asset_disposals.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la baja conserva solicitud, activo, ubicación y motivo", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_asset_disposals/);
  assert.match(migration, /asset_unit_id UUID NOT NULL/);
  assert.match(migration, /location_id UUID NOT NULL/);
  assert.match(migration, /status IN \('SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED'\)/);
});

test("no permite bajas duplicadas ni activos fuera de disponibilidad", () => {
  assert.match(migration, /logistics_asset_disposals_open_unit_idx/);
  assert.match(logistics, /El activo ya tiene la solicitud/);
  assert.match(logistics, /El activo no tiene una ubicación física disponible/);
});

test("la aprobación mantiene segregación de funciones", () => {
  assert.match(logistics, /Quien solicita la baja no puede aprobarla/);
  assert.match(server, /allowSelfApproval: Boolean\(apiProfile\.admin\)/);
  assert.match(server, /syncAssetDisposalTask/);
});

test("contabilizar retira stock y conserva el activo como retirado o perdido", () => {
  assert.match(logistics, /referenceType: "asset_disposal"/);
  assert.match(logistics, /movementType: "ISSUE"/);
  assert.match(logistics, /finalStatus = \["LOST", "STOLEN"\]/);
  assert.match(logistics, /retired_at=\$2/);
});

test("API e interfaz cubren solicitud, aprobación y contabilización", () => {
  assert.match(server, /asset-disposals/);
  assert.match(app, /function assetDisposalMarkup/);
  assert.match(app, /id="assetDisposalForm"/);
  assert.match(app, /data-disposal-action="POST"/);
});
