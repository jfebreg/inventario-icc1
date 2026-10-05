import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
const app=await readFile(new URL("../app.js",import.meta.url),"utf8");
let sequence=0;
const source=app.slice(app.indexOf("function validateMovementInput("),app.indexOf("async function movementSubmit("));
const attempt=runInNewContext(`${source};movementAttempt`,{crypto:{randomUUID:()=>`uuid-${++sequence}`}});

test("el reintento en el mismo formulario conserva la clave original",()=>{
  const form={dataset:{}},payload={assetId:"asset",qty:2};
  const first=attempt(form,payload);
  assert.equal(attempt(form,{...payload}),first);
});
test("un intento sin confirmar no permite cambiar cantidad ni usuario silenciosamente",()=>{
  const form={dataset:{}},payload={assetId:"asset",qty:2,userId:"user"};
  const first=attempt(form,payload);
  assert.throws(()=>attempt(form,{...payload,qty:3}),/pendiente de confirmar/);
  assert.throws(()=>attempt(form,{...payload,userId:"other"}),/pendiente de confirmar/);
  assert.equal(form.dataset.movementAttemptId,first);
});
test("dos formularios nuevos representan operaciones independientes",()=>{
  const payload={assetId:"asset",qty:2};
  assert.notEqual(attempt({dataset:{}},payload),attempt({dataset:{}},payload));
});
test("un ajuste sin motivo no crea un intento pendiente y permite corregirlo",()=>{
  const form={dataset:{}};
  assert.throws(()=>attempt(form,{action:"Ajuste de stock",qty:2,notes:"   "}),/motivo/);
  assert.equal(form.dataset.movementAttemptId,undefined);
  assert.ok(attempt(form,{action:"Ajuste de stock",qty:2,notes:"Conteo físico"}));
});
test("cantidades inválidas se rechazan antes de reservar la clave",()=>{
  for(const qty of [0,-1,NaN,Infinity]){
    const form={dataset:{}};
    assert.throws(()=>attempt(form,{qty}),/cantidad válida/);
    assert.equal(form.dataset.movementAttemptId,undefined);
    assert.ok(attempt(form,{qty:1}));
  }
});
