import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/036_catalog_data_remediation.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la migración conserva responsable, fecha y evidencia de la corrección", () => {
  assert.match(migration, /corrected_by TEXT REFERENCES inventory_user_profiles/);
  assert.match(migration, /corrected_at TIMESTAMPTZ/);
  assert.match(migration, /correction_notes TEXT/);
  assert.match(migration, /correction_data JSONB/);
});

test("la corrección guiada cubre las cinco reglas vigentes", () => {
  assert.match(logistics, /export async function remediateCatalogDataIssue/);
  for (const rule of ["MISSING_FAMILY", "MISSING_BASE_UOM", "ZERO_STANDARD_COST",
    "MISSING_STOCK_POLICY", "MISSING_SERIAL"]) {
    assert.match(logistics, new RegExp(`issue\\.rule_code === "${rule}"`));
  }
});

test("los datos seleccionados se validan dentro de la organización", () => {
  assert.match(logistics, /logistics_item_families[\s\S]*organization_id=\$2 AND active=TRUE/);
  assert.match(logistics, /logistics_units_of_measure[\s\S]*organization_id=\$1 AND code=\$2/);
  assert.match(logistics, /warehouse\.organization_id=item\.organization_id/);
  assert.match(logistics, /unit\.organization_id=\$2/);
});

test("cada corrección deja auditoría y evento transaccional", () => {
  assert.match(logistics, /CATALOG_DATA_REMEDIATED/);
  assert.match(logistics, /catalog\.data\.remediated/);
  assert.match(logistics, /correction_notes=\$2/);
  assert.match(logistics, /before_data,after_data,metadata/);
});

test("la API restringe, corrige y vuelve a verificar", () => {
  assert.match(server, /catalog-quality\\\/\(\[\^\/\]\+\)\\\/remediate/);
  assert.match(server, /remediateCatalogDataIssue/);
  assert.match(server, /Sólo administración puede corregir datos maestros/);
  assert.match(server, /reviewCatalogDataQuality\(pool, logisticsOrganizationId\)/);
});

test("el panel ofrece formulario específico y confirmación controlada", () => {
  assert.match(app, /data-remediate-quality/);
  assert.match(app, /function catalogQualityRemediationModal/);
  assert.match(app, /catalogQualityRemediationForm/);
  assert.match(app, /Aplicar y verificar/);
  assert.match(app, /Fuente y motivo de la corrección/);
});
