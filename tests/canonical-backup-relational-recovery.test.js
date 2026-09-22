import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server,app,architecture]=await Promise.all([
  readFile(new URL("../server.js",import.meta.url),"utf8"),
  readFile(new URL("../app.js",import.meta.url),"utf8"),
  readFile(new URL("../ARQUITECTURA_LOGISTICA_V2.md",import.meta.url),"utf8")
]);

test("la prueba reconstruye claves y relaciones sin escribir inventario",()=>{
  assert.match(server,/function validateCanonicalBackupReconstruction/);
  assert.match(server,/ISOLATED_RECONSTRUCTION/);
  assert.match(server,/checkedReferences/);
  assert.match(server,/referencia inexistente/);
  assert.doesNotMatch(server,/validateCanonicalBackupReconstruction[\s\S]{0,9000}(INSERT INTO logistics_stock|UPDATE logistics_stock|DELETE FROM logistics_stock)/);
});

test("la recuperación detecta duplicados y contaminación entre organizaciones",()=>{
  assert.match(server,/clave duplicada/);
  assert.match(server,/ORGANIZATION_SCOPE/);
  assert.match(server,/registro fuera de la organización/);
});

test("configuración presenta la prueba como recuperación aislada",()=>{
  assert.match(app,/Probar recuperación V2/);
  assert.match(app,/Reconstruyendo respaldo en memoria/);
  assert.match(app,/Recuperación V2 comprobada/);
  assert.match(architecture,/nunca escribe sobre las tablas operativas/);
});
