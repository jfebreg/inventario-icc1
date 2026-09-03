import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/066_automation_service_objectives.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("la política define metas acotadas y una configuración inicial", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_automation_slo_policies/);
  assert.match(migration, /target_success_rate BETWEEN 50 AND 100/);
  assert.match(migration, /evaluation_window_days BETWEEN 7 AND 365/);
  assert.match(migration, /INSPECTION_REPORT_WEEKLY_VERIFICATION',30,95,300000,0/);
});

test("la evaluación compara tasa duración e incidentes con la política", () => {
  assert.match(server, /sloStatus/);
  assert.match(server, /target_success_rate/);
  assert.match(server, /max_average_duration_ms/);
  assert.match(server, /max_open_incidents/);
  assert.match(server, /"BREACH"/);
});

test("sólo administración puede modificar objetivos validados", () => {
  assert.match(server, /\/api\/v1\/inspection-reports\/automation-policy/);
  assert.match(server, /Sólo administración puede configurar los objetivos de automatización/);
  assert.match(server, /targetSuccessRate < 50/);
  assert.match(server, /evaluationWindowDays > 365/);
});

test("Configuración permite editar y muestra cumplimiento", () => {
  assert.match(app, /Objetivo de servicio/);
  assert.match(app, /data-edit-report-slo/);
  assert.match(app, /automationSloPolicyForm/);
  assert.match(app, /Cumple objetivo/);
});
