import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { logisticsValidation } from "../lib/logistics.js";

test("normaliza códigos operativos sin perder los dígitos", () => {
  assert.equal(logisticsValidation.slug("Bodega Central"), "BODEGA-CENTRAL");
  assert.equal(logisticsValidation.slug("IZA-000001"), "IZA-000001");
  assert.equal(logisticsValidation.slug("Obra Túnel"), "OBRA-TUNEL");
});

test("rechaza cantidades nulas, negativas o inválidas", () => {
  assert.equal(logisticsValidation.assertPositiveQuantity("2.5"), 2.5);
  assert.throws(() => logisticsValidation.assertPositiveQuantity(0), /mayor que cero/i);
  assert.throws(() => logisticsValidation.assertPositiveQuantity(-1), /mayor que cero/i);
  assert.throws(() => logisticsValidation.assertPositiveQuantity("no"), /mayor que cero/i);
});

test("sólo permite tipos de movimiento controlados", () => {
  assert.equal(logisticsValidation.assertMovementType("receipt"), "RECEIPT");
  assert.equal(logisticsValidation.assertMovementType("transfer_dispatch"), "TRANSFER_DISPATCH");
  assert.throws(() => logisticsValidation.assertMovementType("borrar stock"), /no permitido/i);
});

test("la clave de saldo es estable y cambia por unidad o ubicación", () => {
  const base = {
    organizationId: "org",
    itemId: "item",
    assetUnitId: null,
    lotId: null,
    locationId: "location-a"
  };
  const first = logisticsValidation.balanceKey(base);
  assert.equal(first, logisticsValidation.balanceKey({ ...base }));
  assert.notEqual(first, logisticsValidation.balanceKey({ ...base, locationId: "location-b" }));
  assert.notEqual(first, logisticsValidation.balanceKey({ ...base, assetUnitId: "unit-1" }));
});

test("la migración contiene las invariantes esenciales", async () => {
  const migration = await readFile(new URL("../migrations/001_logistics_core.sql", import.meta.url), "utf8");
  assert.match(migration, /logistics_stock_ledger/);
  assert.match(migration, /CHECK \(quantity <> 0\)/);
  assert.match(migration, /CHECK \(asset_unit_id IS NULL OR ABS\(quantity\) = 1\)/);
  assert.match(migration, /source_warehouse_id <> destination_warehouse_id/);
  assert.match(migration, /quantity_received <= quantity_dispatched/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("el puente legado conserva una relación única con cada operación canónica", async () => {
  const migration = await readFile(new URL("../migrations/002_legacy_bridge.sql", import.meta.url), "utf8");
  assert.match(migration, /logistics_legacy_links/);
  assert.match(migration, /UNIQUE \(organization_id, legacy_type, legacy_id\)/);
  assert.match(migration, /logistics_transfer_lines_identity_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("los artículos nuevos se registran primero en el catálogo maestro V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function registerCanonicalItem/);
  assert.match(server, /url\.pathname === "\/api\/v1\/items" && req\.method === "POST"/);
  assert.match(app, /async function registerAssetV2/);
  assert.match(app, /await registerAssetV2/);
  assert.match(logistics, /item-opening:/);
});

test("agregar activos iguales crea las unidades primero en V2", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const cloneStart = app.indexOf("if(e.target.id!=='cloneAssetForm')");
  const cloneHandler = app.slice(cloneStart, cloneStart + 5000);
  assert.notEqual(cloneStart, -1);
  assert.match(cloneHandler, /Creando unidades V2/);
  assert.match(cloneHandler, /await registerAssetV2/);
  assert.match(cloneHandler, /await persistState/);
  assert.match(cloneHandler, /await loadLogisticsV2/);
});

test("las inspecciones se registran primero con plantilla versionada en V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function createInspectionRun/);
  assert.match(logistics, /logistics_inspection_template_versions/);
  assert.match(logistics, /INSPECTION_SUBMITTED/);
  assert.match(logistics, /legacy_type='inspection'/);
  assert.match(server, /url\.pathname === "\/api\/v1\/inspections" && req\.method === "POST"/);
  assert.match(server, /profileCan\(apiProfile, "inspect"\)/);
  assert.match(app, /async function registerInspectionV2/);
  const handler = app.slice(app.indexOf("if(e.target.id!=='inspectionForm')"), app.indexOf("if(e.target.id!=='organizationForm')"));
  assert.match(handler, /await registerInspectionV2/);
  assert.match(handler, /await persistState/);
});

test("plazos, correcciones y aprobaciones cierran el ciclo V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function updateInspectionRun/);
  assert.match(logistics, /SET_DEADLINE/);
  assert.match(logistics, /RECORD_CORRECTION/);
  assert.match(logistics, /VERIFY_CORRECTION/);
  assert.match(server, /\/\(deadline\|correction\|approve\|verify\)/);
  assert.match(app, /await updateInspectionV2\(i,'deadline'/);
  assert.match(app, /await updateInspectionV2\(inspection,'correction'/);
  assert.match(app, /data-verify-inspection/);
  assert.match(app, /data-approve-inspection/);
});

test("las bodegas nuevas nacen con ubicaciones operativas en V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function registerWarehouse/);
  assert.match(logistics, /\["STORAGE", "Almacenamiento"\]/);
  assert.match(logistics, /\["RECEIVING", "Recepción"\]/);
  assert.match(logistics, /\["DISPATCH", "Despacho"\]/);
  assert.match(server, /url\.pathname === "\/api\/v1\/warehouses" && req\.method === "POST"/);
  assert.match(server, /profileCan\(apiProfile, "admin"\)/);
  assert.match(app, /async function registerWarehouseV2/);
  assert.match(app, /await registerWarehouseV2\(center\)/);
  assert.match(app, /Creando bodega V2/);
});

test("las familias se configuran primero en el catálogo maestro V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function registerItemFamily/);
  assert.match(logistics, /ITEM_FAMILY_UPDATED/);
  assert.match(server, /url\.pathname === "\/api\/v1\/families" && req\.method === "POST"/);
  assert.match(server, /La abreviatura ya está asignada/);
  assert.match(app, /async function saveFamilyV2/);
  assert.match(app, /await saveFamilyV2\(obj\)/);
  assert.match(app, /Guardando familia V2/);
});

test("la confirmación de facturas ingresa consumibles en V2 sin duplicar líneas", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /async function registerPurchaseLineV2/);
  assert.match(app, /movementType:'RECEIPT'/);
  assert.match(app, /idempotencyKey:`ai-receipt:\$\{draftId\}:\$\{lineIndex\}`/);
  assert.match(app, /if\(a\.type==='Activo'\)throw new Error/);
  assert.match(app, /confirmed=new Set\(d\.confirmedLines\|\|\[\]\)/);
  assert.match(app, /await registerPurchaseLineV2/);
  assert.match(app, /✓ ingresado V2/);
});

test("los archivos quedan identificados y vinculados como documentos V2", async () => {
  const [app, server, logistics] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/logistics.js", import.meta.url), "utf8")
  ]);
  assert.match(logistics, /export async function registerCanonicalDocument/);
  assert.match(logistics, /logistics_document_links/);
  assert.match(logistics, /DOCUMENT_REGISTERED/);
  assert.match(server, /createHash\("sha256"\)/);
  assert.match(server, /registerCanonicalDocument\(pool/);
  assert.match(server, /canonicalDocumentId/);
  assert.match(app, /function canonicalDocumentLink/);
  assert.match(app, /CORRECTION_EVIDENCE/);
  assert.match(app, /doc\.sha256=payload\.sha256/);
});
