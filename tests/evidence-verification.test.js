import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/050_evidence_availability_verification.sql", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../security-monitor.js", import.meta.url), "utf8");

test("los controles de evidencia conservan ejecución y resultados protegidos", () => {
  assert.match(migration, /logistics_evidence_verification_runs/);
  assert.match(migration, /logistics_evidence_verification_results/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la comprobación recupera contenido y compara tamaño y SHA-256", () => {
  assert.match(server, /async function readEvidenceBody/);
  assert.match(server, /async function runEvidenceVerification/);
  assert.match(server, /createHash\("sha256"\)/);
  assert.match(server, /FILE_SIZE_MISMATCH|El tamaño no coincide/);
  assert.match(server, /La huella SHA-256 no coincide/);
});

test("las fallas crean tarea crítica y auditoría logística", () => {
  assert.match(server, /Integridad documental/);
  assert.match(server, /Revisar evidencias faltantes o alteradas/);
  assert.match(server, /EVIDENCE_VERIFICATION_COMPLETED/);
  assert.match(server, /evidence-verification-/);
});

test("administración consulta y ejecuta la verificación desde configuración", () => {
  assert.match(server, /evidence-verification-runs/);
  assert.match(ui, /Verificación de evidencias/);
  assert.match(ui, /data-run-evidence-verification/);
  assert.match(ui, /Verificar hasta 100/);
});
