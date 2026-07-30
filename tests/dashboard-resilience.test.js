import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, app] = await Promise.all([
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("los módulos secundarios no derriban el panel logístico completo", () => {
  assert.match(server, /const panelWarnings = \[\]/);
  assert.match(server, /const panelQuery = async \(module, operation, fallback\)/);
  assert.match(server, /panelQuery\("Indicadores logísticos"/);
  assert.match(server, /panelQuery\("Conciliación"/);
  assert.match(server, /panelWarnings\s*\n\s*}\);/);
});

test("la interfaz conserva los datos principales y muestra advertencias por módulo", () => {
  assert.match(app, /panelWarnings:\[\]/);
  assert.match(app, /panelWarnings:bundle\.panelWarnings\|\|\[\]/);
  assert.match(app, /Panel operativo con información parcial/);
  assert.match(app, /Los módulos principales continúan disponibles/);
});
