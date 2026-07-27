import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/030_replenishment_scheduler.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la agenda incorpora revisión diaria de abastecimiento", () => {
  assert.match(migration, /REPLENISHMENT_DAILY_REVIEW/);
  assert.match(migration, /America\/Santiago',8/);
  assert.match(migration, /ON CONFLICT \(organization_id,job_code\) DO NOTHING/);
});

test("la revisión queda aislada por organización", () => {
  assert.match(logistics, /listReplenishmentSuggestions\(pool, profile, organizationId = ""\)/);
  assert.match(logistics, /organizationScope/);
  assert.match(logistics, /item\.organization_id=\$/);
});

test("crea tareas deterministas y cierra las recuperadas", () => {
  assert.match(logistics, /export async function reviewReplenishmentTasks/);
  assert.match(logistics, /task_type='REPLENISHMENT_REVIEW'/);
  assert.match(logistics, /status='Resuelta'/);
  assert.match(logistics, /taskId: `replenishment-\$\{createHash/);
  assert.match(logistics, /inventory_tasks\.status='En proceso'/);
  assert.match(logistics, /INSERT INTO inventory_notifications/);
});

test("el programador ejecuta revisión sin crear compras", () => {
  assert.match(logistics, /job\.job_code === "REPLENISHMENT_DAILY_REVIEW"/);
  assert.match(logistics, /reviewReplenishmentTasks/);
  assert.doesNotMatch(logistics.match(/export async function reviewReplenishmentTasks[\s\S]*?export async function createPurchaseRequisition/)?.[0] || "",
    /INSERT INTO logistics_purchase_requisitions/);
});

test("API e interfaz permiten revisar y muestran la próxima ejecución", () => {
  assert.match(server, /\/api\/v1\/replenishment\/review/);
  assert.match(server, /SÃ³lo administraciÃ³n puede ejecutar la revisiÃ³n general/);
  assert.match(app, /data-review-replenishment/);
  assert.match(app, /Revisión automática/);
  assert.match(app, /reposición\(es\) requieren gestión/);
});
