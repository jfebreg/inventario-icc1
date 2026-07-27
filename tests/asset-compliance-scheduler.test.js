import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el servidor revisa vencimientos periódicamente sin ejecuciones superpuestas", () => {
  assert.match(server, /async function sweepAssetComplianceTasks/);
  assert.match(server, /complianceSweepRunning/);
  assert.match(server, /15 \* 60 \* 1000/);
  assert.match(server, /startComplianceScheduler/);
});

test("sólo crea tareas dentro de la ventana de aviso", () => {
  assert.match(server, /record\.effective_status === "ACTIVE"/);
  assert.match(server, /status='Resuelta'/);
  assert.match(server, /Number\(record\.days_remaining\) <= 7 \? "Alta" : "Media"/);
});

test("el barrido cierra tareas de registros renovados o revocados", () => {
  assert.match(server, /task\.entity_type='asset_compliance'/);
  assert.match(server, /compliance\.status='ACTIVE'/);
  assert.match(server, /resolved_at=COALESCE\(resolved_at,NOW\(\)\)/);
});

test("la administración puede ejecutar una revisión inmediata", () => {
  assert.match(server, /\/api\/v1\/asset-compliance\/sweep/);
  assert.match(server, /Sólo el administrador puede ejecutar la revisión general/);
  assert.match(app, /data-sweep-compliance/);
  assert.match(app, /Revisión automática cada 15 minutos/);
});
