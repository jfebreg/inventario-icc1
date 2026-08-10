import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("las cargas usan una lista cerrada de formatos operativos", () => {
  assert.match(server, /function decodeValidatedFile/);
  for (const extension of ["pdf", "jpg", "png", "webp", "docx", "xlsx", "xlsm", "csv", "txt"]) {
    assert.match(server, new RegExp(`"\\.${extension}"`));
  }
  assert.match(server, /FILE_TYPE_NOT_ALLOWED/);
  assert.doesNotMatch(server, /"\.html": \{ kind:/);
  assert.doesNotMatch(server, /"\.svg": \{ kind:/);
});

test("el contenido se valida por firma binaria y no sólo por extensión", () => {
  assert.match(server, /function fileSignatureMatches/);
  assert.match(server, /%PDF-/);
  assert.match(server, /0xd0, 0xcf, 0x11, 0xe0/);
  assert.match(server, /\[Content_Types\]\.xml/);
  assert.match(server, /FILE_SIGNATURE_MISMATCH/);
  assert.ok((server.match(/decodeValidatedFile\(body\.dataUrl, body\.filename\)/g) || []).length >= 2);
});

test("base64, tamaño y acceso a IA se controlan en servidor", () => {
  assert.match(server, /INVALID_BASE64/);
  assert.match(server, /FILE_TOO_LARGE/);
  assert.match(server, /profileCan\(apiProfile, "ai"\)/);
  assert.match(server, /Tu perfil no puede digitalizar documentos con IA/);
});
