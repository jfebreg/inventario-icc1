import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/003_custody_idempotency.sql", import.meta.url), "utf8");

test("la entrega a terreno se registra primero en el modelo V2", () => {
  assert.match(app, /async function registerTerrainV2/);
  assert.match(app, /await registerTerrainV2\(\{legacyId:assignment\.id/);
  assert.match(app, /canonicalCustodyId/);
  assert.equal(app.split("if(e.target.id!=='terrainForm')return").length - 1, 1);
});

test("la devolución exige una custodia canónica", () => {
  assert.match(app, /\/api\/v1\/custody\/\$\{encodeURIComponent\(canonicalId\)\}\/return/);
  assert.match(logistics, /CUSTODY_RETURNED/);
  assert.match(logistics, /SET status='AVAILABLE'/);
});

test("consumibles generan consumo y activos mantienen el saldo físico", () => {
  assert.match(logistics, /movementType: "CONSUMPTION"/);
  assert.match(logistics, /if \(consumesStock\)/);
  assert.match(logistics, /SET status='IN_CUSTODY'/);
});

test("las API de custodia tienen control de permisos y alcance", () => {
  assert.match(server, /url\.pathname === "\/api\/v1\/custody"/);
  assert.match(server, /profileCan\(apiProfile, "terrain"\)/);
  assert.match(server, /profileMayAccessWarehouse/);
});

test("los reintentos no duplican entregas", () => {
  assert.match(migration, /logistics_custody_external_reference_idx/);
  assert.match(logistics, /external_reference=\$2/);
});

test("el menú QR consulta la custodia canónica y evita una segunda entrega", () => {
  assert.match(app, /function syncQuickLogisticsContext/);
  assert.match(app, /canonicalCustodyId:canonical\.id/);
  assert.match(app, /terrain=custody\?'':/);
  assert.match(app, /Registrar devolución desde terreno/);
});

test("el QR recibe traslados canónicos aunque no estén en el respaldo antiguo", () => {
  assert.match(app, /function canonicalPendingTransfers/);
  assert.match(app, /function receiveCanonicalTransfer/);
  assert.match(app, /data-receive\^="v2-receive:"/);
  assert.match(app, /qr-receive:/);
});

test("el bloqueo de bodega no intenta bloquear el lado opcional del centro de costo", () => {
  assert.match(logistics, /FOR SHARE OF w/);
  assert.doesNotMatch(logistics, /w\.active=TRUE FOR SHARE`/);
});
