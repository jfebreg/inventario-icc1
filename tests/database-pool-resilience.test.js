import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const guide = await readFile(new URL("../GUIA_PUBLICACION.md", import.meta.url), "utf8");

test("PostgreSQL utiliza un pool acotado y conexiones con plazo", () => {
  assert.match(server, /DB_POOL_MAX/);
  assert.match(server, /max: databasePoolMax/);
  assert.match(server, /idleTimeoutMillis: 30_000/);
  assert.match(server, /connectionTimeoutMillis: databaseConnectionTimeoutMs/);
  assert.match(server, /keepAlive: true/);
  assert.match(server, /maxUses: 7_500/);
});

test("las consultas no pueden quedar abiertas indefinidamente", () => {
  assert.match(server, /DB_STATEMENT_TIMEOUT_MS/);
  assert.match(server, /statement_timeout: databaseStatementTimeoutMs/);
  assert.match(server, /query_timeout: databaseStatementTimeoutMs \+ 2_000/);
  assert.match(server, /boundedNumber\(process\.env\.DB_STATEMENT_TIMEOUT_MS, 15_000, 3_000, 120_000\)/);
});

test("fallas inesperadas y saturacion del pool quedan visibles", () => {
  assert.match(server, /pool\.on\("error"/);
  assert.match(server, /database_pool_error/);
  assert.match(server, /pool\.waitingCount/);
  assert.match(server, /pool\.totalCount/);
});

test("la guia documenta los ajustes opcionales sin exigirlos", () => {
  assert.match(guide, /DB_POOL_MAX/);
  assert.match(guide, /DB_STATEMENT_TIMEOUT_MS/);
  assert.match(guide, /opcionales/i);
});
