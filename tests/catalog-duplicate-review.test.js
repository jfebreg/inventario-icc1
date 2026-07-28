import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/037_catalog_duplicate_review.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la migración habilita similitud y conserva la decisión humana", () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(migration, /gin_trgm_ops/);
  assert.match(migration, /NOT_DUPLICATE/);
  assert.match(migration, /CONFIRMED_DUPLICATE/);
  assert.match(migration, /reviewed_by TEXT REFERENCES inventory_user_profiles/);
});

test("la detección compara sólo artículos vigentes de la misma organización", () => {
  assert.match(logistics, /POSSIBLE_DUPLICATE/);
  assert.match(logistics, /second\.organization_id=first\.organization_id/);
  assert.match(logistics, /first\.organization_id=\$1 AND first\.active=TRUE/);
  assert.match(logistics, /similarity\(LOWER\(first\.name\),LOWER\(second\.name\)\)>=0\.78/);
});

test("el puntaje conserva evidencia explicable", () => {
  assert.match(logistics, /nameSimilarity/);
  assert.match(logistics, /sameBrand/);
  assert.match(logistics, /sameModel/);
  assert.match(logistics, /confidence/);
});

test("un descarte revisado no vuelve a abrirse automáticamente", () => {
  assert.match(logistics, /status=CASE WHEN logistics_data_quality_issues\.status='WAIVED'/);
  assert.match(logistics, /if \(savedIssue\.status === "WAIVED"\) continue/);
  assert.match(logistics, /decision === "NOT_DUPLICATE" \? "WAIVED" : "OPEN"/);
});

test("la decisión queda auditada y no fusiona saldos", () => {
  assert.match(logistics, /CATALOG_DUPLICATE_REVIEWED/);
  assert.match(logistics, /catalog\.duplicate\.reviewed/);
  assert.doesNotMatch(logistics, /CATALOG_DUPLICATE_REVIEWED[\s\S]{0,800}UPDATE logistics_stock_balances/);
});

test("API y panel permiten comparar sin exponer la función a usuarios comunes", () => {
  assert.match(server, /duplicate-decision/);
  assert.match(server, /Sólo administración puede revisar duplicados/);
  assert.match(app, /function catalogDuplicateReviewModal/);
  assert.match(app, /data-review-duplicate/);
  assert.match(app, /Los movimientos y saldos no serán modificados/);
});
