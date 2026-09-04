import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");

test("la tarea se asigna al administrador central activo", () => {
  assert.match(logistics, /active=TRUE AND admin=TRUE AND auth_user_id IS NOT NULL/);
  assert.match(logistics, /LOWER\(email\)='jfebreg@msn\.com'/);
  assert.match(logistics, /assignee_auth_user_id=COALESCE/);
  assert.match(logistics, /recipient_auth_user_id/);
});

test("el vencimiento escala una sola vez", () => {
  assert.match(logistics, /'escalatedAt',NOW\(\)/);
  assert.match(logistics, /due_at<=NOW\(\)/);
  assert.match(logistics, /NOT \(COALESCE\(payload,'\{\}'::jsonb\) \? 'escalatedAt'\)/);
  assert.match(logistics, /'OUTBOX_HEALTH_ESCALATED'/);
  assert.match(logistics, /'OUTBOX_SLO_ESCALATED'/);
  assert.match(logistics, /WHEN inventory_tasks\.status='Resuelta' THEN EXCLUDED\.due_at/);
  assert.match(logistics, /COALESCE\(inventory_tasks\.payload,'\{\}'::jsonb\)\|\|EXCLUDED\.payload/);
});

test("la recuperación cierra todas las alertas del monitor", () => {
  assert.match(logistics, /WHERE entity_type='outbox_monitor' AND entity_id=\$1 AND read_at IS NULL/);
  assert.match(logistics, /status: escalation \? "ESCALATED" : "BREACHED"/);
});
