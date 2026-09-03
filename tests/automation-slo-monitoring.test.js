import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8");

test("el monitor evalúa todas las dimensiones configuradas", () => {
  assert.match(server, /async function evaluateInspectionReportAutomationSlo/);
  assert.match(server, /successRate < Number\(policy\.target_success_rate\)/);
  assert.match(server, /averageDurationMs > Number\(policy\.max_average_duration_ms\)/);
  assert.match(server, /openIncidents > Number\(policy\.max_open_incidents\)/);
});

test("un incumplimiento abre tarea notifica y audita una sola transición", () => {
  assert.match(server, /'AUTOMATION_SLO'/);
  assert.match(server, /'AUTOMATION_SLO_BREACH'/);
  assert.match(server, /'AUTOMATION_SLO_BREACHED'/);
  assert.match(server, /!current \|\| current\.status === "Resuelta"/);
});

test("la recuperación resuelve tarea atiende alertas y deja evidencia", () => {
  assert.match(server, /'AUTOMATION_SLO_RECOVERED'/);
  assert.match(server, /entity_type='automation_slo'/);
  assert.match(server, /Objetivo de servicio recuperado/);
  assert.match(server, /status: "COMPLIANT"/);
});

test("el barrido devuelve el resultado de vigilancia", () => {
  assert.match(server, /const inspectionReportSlo = await evaluateInspectionReportAutomationSlo\(\)/);
  assert.match(server, /evidence, inspectionReportSlo, escalations/);
  assert.match(architecture, /Cada barrido evalúa la meta en el servidor/);
});
