import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [logistics, server] = await Promise.all([
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8")
]);

test("las uniones de perfiles aceptan identificadores heredados y UUID", () => {
  const combined = `${logistics}\n${server}`;
  assert.match(combined, /opener\.id::text=period\.opened_by::text/);
  assert.match(combined, /requester\.id::text=adjustment\.requested_by::text/);
  assert.match(combined, /requester\.id::text=purchase_order\.requested_by::text/);
  assert.match(combined, /registrar\.id::text=invoice\.registered_by::text/);
  assert.match(combined, /requester\.id::text=disposal\.requested_by::text/);
  assert.match(combined, /owner\.id::text=incident\.owner_profile_id::text/);
});

test("el panel no conserva uniones directas text igual uuid conocidas", () => {
  for (const pattern of [
    /opener\.id=period\.opened_by/,
    /requester\.id=adjustment\.requested_by/,
    /requester\.id=purchase_order\.requested_by/,
    /registrar\.id=invoice\.registered_by/,
    /requester\.id=disposal\.requested_by/,
    /owner\.id=incident\.owner_profile_id/
  ]) assert.doesNotMatch(`${logistics}\n${server}`, pattern);
});
