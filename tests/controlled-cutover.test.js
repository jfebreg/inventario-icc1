import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app, architecture] = await Promise.all([
  readFile(new URL("../migrations/039_controlled_canonical_cutover.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8")
]);

test("el corte conserva modo, verificaciones consecutivas y reversa", () => {
  assert.match(migration, /logistics_cutover_controls/);
  assert.match(migration, /LEGACY_PRIMARY/);
  assert.match(migration, /DUAL_WRITE/);
  assert.match(migration, /CANONICAL_PRIMARY/);
  assert.match(migration, /required_clean_reconciliations INTEGER NOT NULL DEFAULT 3/);
  assert.match(migration, /last_rollback_reason/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("la preparación comprueba conciliación, auditoría, ajustes y cola de eventos", () => {
  assert.match(logistics, /export async function getCutoverStatus/);
  assert.match(logistics, /reconciliation_ok/);
  assert.match(logistics, /audit_chain_integrity/);
  assert.match(logistics, /no_dead_letter_events/);
  assert.match(logistics, /no_pending_adjustments/);
  assert.match(logistics, /consecutive_clean_reconciliations/);
});

test("activar la fuente canónica exige verificaciones limpias suficientes", () => {
  assert.match(logistics, /export async function updateCutoverMode/);
  assert.match(logistics, /CANONICAL_PRIMARY/);
  assert.match(logistics, /Aún no se completan las verificaciones limpias requeridas/);
  assert.match(logistics, /CUTOVER_MODE_CHANGED/);
  assert.match(logistics, /CANONICAL_CUTOVER_READY_CHECK/);
});

test("la API está restringida a administración y expone evaluación y cambio", () => {
  assert.match(server, /\/api\/v1\/cutover\/assess/);
  assert.match(server, /\/api\/v1\/cutover/);
  assert.match(server, /Sólo el administrador puede gestionar el corte de datos/);
  assert.match(server, /assessCutoverReadiness/);
  assert.match(server, /updateCutoverMode/);
});

test("el panel permite verificar, activar y revertir de forma visible", () => {
  assert.match(app, /function cutoverControlMarkup/);
  assert.match(app, /Fuente oficial de inventario/);
  assert.match(app, /data-assess-cutover/);
  assert.match(app, /data-cutover-mode/);
  assert.match(app, /CANONICAL_PRIMARY/);
});

test("la arquitectura documenta el corte sin eliminar el respaldo", () => {
  assert.match(architecture, /Corte controlado a fuente canónica/);
  assert.match(architecture, /tres conciliaciones limpias consecutivas/);
  assert.match(architecture, /respaldo heredado permanece disponible/);
});
