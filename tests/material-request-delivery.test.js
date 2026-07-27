import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/025_material_request_delivery.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la solicitud distingue despacho, tránsito y recepción", () => {
  assert.match(migration, /'IN_TRANSIT','RECEIVED'/);
  assert.match(migration, /transfer_id UUID REFERENCES logistics_transfer_orders/);
  assert.match(migration, /received_by TEXT REFERENCES inventory_user_profiles/);
  assert.match(migration, /receiver_name TEXT/);
});

test("cada línea de traslado conserva la reserva y ubicación de origen", () => {
  assert.match(migration, /source_location_id UUID REFERENCES logistics_locations/);
  assert.match(migration, /request_reservation_id UUID REFERENCES logistics_stock_reservations/);
  assert.match(migration, /logistics_transfer_lines_reservation_idx/);
});

test("despachar entre bodegas mueve el stock a tránsito sin consumirlo", () => {
  assert.match(logistics, /targetStatus === "IN_TRANSIT"/);
  assert.match(logistics, /movementType: "TRANSFER_DISPATCH"/);
  assert.match(logistics, /fromLocationId: reservation.location_id/);
  assert.match(logistics, /toLocationId: transit.id/);
  assert.match(logistics, /materialRequestId: current.id/);
});

test("recibir lleva el saldo desde tránsito a la bodega solicitante", () => {
  assert.match(logistics, /normalizedAction === "RECEIVE"/);
  assert.match(logistics, /movementType: "TRANSFER_RECEIPT"/);
  assert.match(logistics, /toLocationId: destination.id/);
  assert.match(logistics, /receiverName/);
});

test("la recepción genérica mantiene sincronizada la solicitud asociada", () => {
  assert.match(logistics, /UPDATE logistics_material_requests request SET status='RECEIVED'/);
  assert.match(logistics, /WHERE request.transfer_id=\$2 AND request.status='IN_TRANSIT'/);
});

test("API e interfaz exponen confirmación de recepción", () => {
  assert.match(server, /"ALLOCATE", "START_PICK", "ISSUE"/);
  assert.match(app, /data-material-action="RECEIVE"/);
  assert.match(app, /Confirmar recepción/);
  assert.match(app, /receiverName/);
});
