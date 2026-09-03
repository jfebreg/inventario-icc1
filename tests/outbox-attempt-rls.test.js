import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/070_outbox_delivery_attempts_rls.sql", import.meta.url), "utf8");

test("la bitácora de entrega exige acceso a través del servidor", () => {
  assert.match(migration, /ALTER TABLE logistics_outbox_delivery_attempts ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON logistics_outbox_delivery_attempts FROM anon,authenticated/);
  assert.match(migration, /acceso exclusivo mediante el servidor/);
});
