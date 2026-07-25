import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("la lectura QR móvil muestra una vista exclusiva de acciones", () => {
  assert.match(app, /quick-mobile-only/);
  assert.match(app, /quick-desktop-only/);
  assert.match(css, /\.quick-mobile-only,\.mobile-dashboard-actions\{display:block\}/);
  assert.match(css, /\.quick-desktop-only,\.desktop-dashboard-full\{display:none\}/);
});

test("el inicio móvil oculta el resumen completo", () => {
  assert.match(app, /mobile-dashboard-actions/);
  assert.match(app, /desktop-dashboard-full/);
  assert.match(css, /\.desktop-dashboard-full\{display:none\}/);
  assert.match(app, /window\.matchMedia\?\.\('\(max-width: 900px\)'\)\.matches/);
});

test("el QR conserva y precarga el producto durante autenticación", () => {
  assert.match(app, /icc-pending-qr-code/);
  assert.match(app, /function scannedAsset\(\)/);
  assert.match(app, /value="\$\{htmlSafe\(code\)\}"/);
  assert.match(app, /Producto identificado por QR/);
  assert.match(app, /if\(!a\)\{route='scan';return true\}/);
});

test("el menú móvil tiene fondo y cierre explícito", () => {
  assert.match(html, /id="menuBackdrop"/);
  assert.match(app, /function closeMobileMenu/);
  assert.match(app, /sidebar \[data-route\]/);
  assert.match(css, /\.app-shell\.menu-open \.menu-backdrop\{display:block\}/);
});

test("las acciones móviles incluyen entrega a terreno", () => {
  assert.match(app, /function renderMobileTerrainShortcut/);
  assert.match(app, /data-mobile-terrain/);
  assert.match(app, /deliveryModal\(a\.id\)/);
});
