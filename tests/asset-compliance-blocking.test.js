import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el libro mayor bloquea equipos con requisitos críticos vencidos", () => {
  assert.match(logistics, /async function assertAssetComplianceOperational/);
  assert.match(logistics, /status='ACTIVE' AND critical=TRUE/);
  assert.match(logistics, /expires_at<CURRENT_DATE/);
  assert.match(logistics, /Equipo bloqueado por cumplimiento vencido/);
});

test("recepciones y devoluciones continúan permitidas", () => {
  assert.match(logistics, /TRANSFER_RECEIPT.*CUSTODY_RETURN.*ADJUSTMENT.*REVERSAL/);
  assert.match(logistics, /assertAssetComplianceOperational\(client, assetUnitId, input\)/);
});

test("la excepción sólo puede provenir del administrador y queda auditada", () => {
  assert.match(server, /apiProfile\.admin && body\.allowComplianceOverride/);
  assert.match(logistics, /ASSET_COMPLIANCE_OVERRIDE/);
  assert.match(logistics, /complianceOverrideReason/);
  assert.match(logistics, /complianceRecordId/);
});

test("el QR explica el bloqueo y deshabilita salidas", () => {
  assert.match(app, /function complianceBlockForAsset/);
  assert.match(app, /Equipo bloqueado por vencimiento/);
  assert.match(app, /Renueva el antecedente antes de despachar o entregar/);
  assert.match(app, /data-start-move="Salida a centro de costo" \$\{block\?'disabled':''\}/);
});
