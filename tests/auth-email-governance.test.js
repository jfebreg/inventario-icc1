import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, authClient] = await Promise.all([
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase-auth.js", import.meta.url), "utf8")
]);

test("las invitaciones respetan una espera configurable y actualizan el último envío", () => {
  assert.match(server, /AUTH_EMAIL_COOLDOWN_SECONDS/);
  assert.match(server, /authEmailCooldownRemaining/);
  assert.match(server, /Ya se enviÃ³ un enlace recientemente|Ya se envió un enlace recientemente/);
  assert.match(server, /invited_at=NOW\(\)/);
});

test("el límite externo de Supabase se traduce a un mensaje comprensible", () => {
  assert.match(server, /friendlyAuthEmailError/);
  assert.match(server, /AUTH_EMAIL_RATE_LIMIT/);
  assert.match(server, /Supabase alcanzÃ³ el lÃ­mite de correos|Supabase alcanzó el límite de correos/);
});

test("el formulario de activación impide envíos simultáneos", () => {
  assert.match(authClient, /dataset\.submitting === "true"/);
  assert.match(authClient, /submitButton\.disabled = true/);
  assert.match(authClient, /Enviando una sola vez/);
});

test("el bootstrap limita intentos, no registra el token y queda auditado", () => {
  assert.match(server, /consumeBootstrapAttempt/);
  assert.match(server, /BOOTSTRAP_TOKEN_REJECTED/);
  assert.match(server, /BOOTSTRAP_INVITATION_SENT/);
  assert.match(server, /BOOTSTRAP_REJECTED_ALREADY_ACTIVE/);
  assert.match(server, /requestFingerprint/);
  assert.doesNotMatch(server, /metadata:\s*\{[^}]*token/i);
});
