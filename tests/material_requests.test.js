import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/010_internal_material_requests.sql", import.meta.url), "utf8");
const logistics = readFileSync(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("el modelo separa solicitud, líneas y reservas físicas", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_material_requests/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_material_request_lines/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_stock_reservations/);
  assert.match(migration, /'ACTIVE','ISSUED','RELEASED'/);
  assert.match(migration, /logistics_stock_reservations_active_unit_idx/);
});

test("la disponibilidad descuenta reservas activas sin alterar el saldo físico", () => {
  assert.match(logistics, /reserved_quantity/);
  assert.match(logistics, /available_quantity/);
  assert.match(logistics, /reservation\.status='ACTIVE'/);
  assert.match(logistics, /Stock insuficiente\. Disponible:/);
});

test("la solicitud exige aprobación y reserva completa antes de preparar", () => {
  assert.match(logistics, /SUBMIT: \{ from: \["DRAFT"\], to: "SUBMITTED" \}/);
  assert.match(logistics, /APPROVE: \{ from: \["SUBMITTED"\], to: "APPROVED" \}/);
  assert.match(logistics, /ALLOCATE: \{ from: \["APPROVED"\], to: "ALLOCATED" \}/);
  assert.match(logistics, /Stock disponible insuficiente para/);
  assert.match(logistics, /Quien solicitó materiales no puede aprobar su propia solicitud/);
});

test("cancelar libera reservas y entregar contabiliza consumo idempotente", () => {
  assert.match(logistics, /status='RELEASED'/);
  assert.match(logistics, /released_at=NOW\(\)/);
  assert.match(logistics, /material-request:\$\{current\.id\}:reservation:\$\{reservation\.id\}:issue/);
  assert.match(logistics, /movementType: reservation\.item_type/);
  assert.match(logistics, /status='ISSUED'/);
});

test("API e interfaz cubren solicitud, reserva, preparación y entrega", () => {
  assert.match(server, /\/api\/v1\/material-requests/);
  assert.match(server, /createMaterialRequest/);
  assert.match(server, /updateMaterialRequest/);
  assert.match(app, /function materialRequestsV2Markup/);
  assert.match(app, /data-material-action="ALLOCATE"/);
  assert.match(app, /data-material-action="START_PICK"/);
  assert.match(app, /data-material-action="ISSUE"/);
  assert.match(app, /id="materialRequestForm"/);
});
