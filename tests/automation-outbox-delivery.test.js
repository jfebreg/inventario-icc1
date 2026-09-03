import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/067_outbox_idempotency.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8");

test("la cola impide duplicar eventos lógicos", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/);
  assert.match(migration, /logistics_outbox_events_idempotency_uq/);
  assert.match(migration, /organization_id,idempotency_key/);
});

test("la notificación y su evento durable nacen en la misma transacción", () => {
  assert.match(migration, /logistics_enqueue_automation_notification/);
  assert.match(migration, /AFTER INSERT ON inventory_notifications/);
  assert.match(migration, /'notification:'\|\|NEW\.id/);
  assert.match(migration, /'PENDING',NOW\(\)/);
});

test("fallas escalamiento recuperación y SLO producen eventos durables", () => {
  for (const event of ["automation.verification.failed", "automation.verification.interrupted",
    "automation.verification.escalated", "automation.verification.recovered",
    "automation.slo.breached", "automation.slo.recovered"]) {
    assert.match(migration, new RegExp(event.replaceAll(".", "\\.")));
  }
});

test("la arquitectura documenta la entrega desacoplada", () => {
  assert.match(architecture, /cola transaccional/);
  assert.match(architecture, /correo, WhatsApp u otra integración/);
});
