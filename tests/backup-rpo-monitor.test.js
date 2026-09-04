import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server] = await Promise.all([
  readFile(new URL("../migrations/071_backup_rpo_monitor.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8")
]);

test("la agenda incorpora vigilancia diaria del RPO de respaldo", () => {
  assert.match(migration, /BACKUP_RPO_DAILY_CHECK/);
  assert.match(migration, /America\/Santiago/);
  assert.match(migration, /ON CONFLICT \(organization_id,job_code\) DO NOTHING/);
});

test("el monitor abre y cierra una tarea sin alterar inventario", () => {
  assert.match(logistics, /BACKUP_RPO_BREACH/);
  assert.match(logistics, /ageHours > 24/);
  assert.match(logistics, /status='Resuelta'/);
  assert.doesNotMatch(logistics, /BACKUP_RPO_DAILY_CHECK[\s\S]{0,2000}UPDATE logistics_stock_balances/);
});

test("la preparación productiva exige la migración del monitor", () => {
  assert.match(server, /latestMigration\.startsWith\("071_"\)/);
});
