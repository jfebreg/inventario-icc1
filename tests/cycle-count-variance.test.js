import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, app] = await Promise.all([
  readFile(new URL("../migrations/033_cycle_count_variance_control.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("el modelo admite reconteo y conserva ambos resultados", () => {
  assert.match(migration, /RECOUNT_REQUIRED/);
  assert.match(migration, /recount_quantity/);
  assert.match(migration, /recount_by TEXT/);
  assert.match(migration, /variance_reason_code/);
});

test("la tolerancia proviene de la política ABC vigente", () => {
  assert.match(logistics, /logistics_inventory_classifications/);
  assert.match(logistics, /logistics_classification_policies/);
  assert.match(logistics, /policy\.tolerance_percent/);
  assert.match(logistics, /recount_required=ABS/);
});

test("las diferencias fuera de tolerancia no pasan directamente a aprobación", () => {
  assert.match(logistics, /status='RECOUNT_REQUIRED'/);
  assert.match(logistics, /CYCLE_COUNT_RECOUNT_REQUIRED/);
  assert.match(logistics, /return \{ cycleCount, recountRequired \}/);
});

test("el reconteo exige otra persona y un motivo controlado", () => {
  assert.match(logistics, /counted_by IS DISTINCT FROM \$2/);
  assert.match(logistics, /allowedReasons/);
  assert.match(logistics, /Selecciona un motivo válido para la diferencia/);
  assert.match(logistics, /CYCLE_COUNT_RECOUNTED/);
});

test("la contabilización usa el valor del reconteo sin borrar el inicial", () => {
  assert.match(logistics, /line\.recount_quantity == null/);
  assert.match(logistics, /const difference = finalCounted/);
  assert.match(logistics, /conteo final: \$\{finalCounted\}/);
});

test("la interfaz guía el reconteo y captura su justificación", () => {
  assert.match(app, /Realizar reconteo/);
  assert.match(app, /data-mode="\$\{recountMode\?'RECOUNT':'COUNT'\}"/);
  assert.match(app, /Error del primer conteo/);
  assert.match(app, /Guardar y enviar reconteo/);
});
