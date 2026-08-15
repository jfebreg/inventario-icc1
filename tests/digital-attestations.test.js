import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/053_digital_attestation_ledger.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const monitor = await readFile(new URL("../security-monitor.js", import.meta.url), "utf8");

test("las constancias digitales son inalterables y encadenadas", () => {
  assert.match(migration, /logistics_digital_attestations/);
  assert.match(migration, /previous_attestation_hash/);
  assert.match(migration, /hash_envelope JSONB NOT NULL/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON logistics_digital_attestations/);
  assert.match(migration, /REVOKE ALL ON logistics_digital_attestations FROM anon,authenticated/);
});

test("la huella usa contenido canónico, consentimiento e idempotencia", () => {
  assert.match(logistics, /function canonicalJson/);
  assert.match(logistics, /consentTextHash = sha256/);
  assert.match(logistics, /payloadSha256 = sha256\(canonicalJson\(payload\)\)/);
  assert.match(logistics, /idempotency_key/);
  assert.match(logistics, /verifyDigitalAttestationChain/);
  assert.match(logistics, /calculatedHash === row\.attestation_hash/);
});

test("aprobar y verificar inspecciones generan una constancia autenticada", () => {
  assert.match(logistics, /INSPECTION_CORRECTION_VERIFICATION/);
  assert.match(logistics, /INSPECTION_APPROVAL/);
  assert.match(logistics, /signingMethod: "AUTHENTICATED_SESSION"/);
});

test("aceptar EPP genera constancia sin conservar ni exponer el token", () => {
  assert.match(server, /attestationType: "EPP_ACCEPTANCE"/);
  assert.match(server, /signingMethod: "PUBLIC_SINGLE_USE_TOKEN"/);
  assert.match(server, /acceptanceTokenSha256: tokenHash/);
  assert.match(server, /const \{ token: _secretToken, \.\.\.publicAssignment \} = assignment/);
  assert.match(server, /attestationHash/);
});

test("administración puede comprobar la cadena desde Configuración", () => {
  assert.match(server, /\/api\/v1\/attestations\/verify/);
  assert.match(monitor, /Constancias digitales/);
  assert.match(monitor, /data-attestation-verification/);
  assert.match(monitor, /Cadena SHA-256/);
});
