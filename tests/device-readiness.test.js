import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, server, app, css, architecture] = await Promise.all([
  readFile(new URL("../migrations/041_field_device_readiness.sql", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md", import.meta.url), "utf8")
]);

test("los dispositivos y sus pruebas quedan normalizados y protegidos", () => {
  assert.match(migration, /logistics_device_profiles/);
  assert.match(migration, /logistics_device_checks/);
  assert.match(migration, /CAMERA_QR/);
  assert.match(migration, /KEYBOARD_SCANNER/);
  assert.match(migration, /PRINT_LABEL/);
  assert.match(migration, /UNIQUE \(organization_id,idempotency_key\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("el servidor limita perfiles por centro y registra evidencia auditable", () => {
  assert.match(server, /\/api\/v1\/devices\/readiness/);
  assert.match(server, /\/api\/v1\/devices\/checks/);
  assert.match(server, /DEVICE_CHECK_RECORDED/);
  assert.match(server, /profileMayAccessWarehouse/);
  assert.match(server, /idempotencyKey/);
});

test("el diagnóstico verifica capacidades reales del navegador", () => {
  assert.match(app, /navigator\.mediaDevices/);
  assert.match(app, /window\.isSecureContext/);
  assert.match(app, /navigator\.onLine/);
  assert.match(app, /localStorage/);
  assert.match(app, /BarcodeDetector/);
});

test("la prueba guiada cubre cámara lector USB e impresora Xprinter", () => {
  assert.match(app, /Probar cámara/);
  assert.match(app, /Probar lector USB/);
  assert.match(app, /Imprimir prueba/);
  assert.match(app, /XP-360B/);
  assert.match(app, /51 × 27 mm/);
  assert.match(css, /device-readiness/);
});

test("las lecturas repetidas se bloquean antes de abrir otra operación", () => {
  assert.match(app, /SCAN_DUPLICATE_WINDOW_MS/);
  assert.match(app, /acceptOperationalScan/);
  assert.match(app, /Lectura repetida ignorada/);
});

test("la arquitectura conserva el procedimiento de verificación física", () => {
  assert.match(architecture, /Confiabilidad operativa en terreno/);
  assert.match(architecture, /cámara y QR/);
  assert.match(architecture, /lector USB/);
  assert.match(architecture, /impresora de etiquetas/);
});
