import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function canonicalLocation('),app.indexOf('function fefoAllocations('));
function select(locations){return runInNewContext(`${source};canonicalLocation`,{canonicalWarehouse:name=>name==='Central'?{locations}:null});}

test('un movimiento normal elige almacenamiento y no la primera ubicación',()=>{
  const storage={id:'storage',type:'STORAGE'};
  assert.equal(select([{id:'quarantine',type:'QUARANTINE'},storage])('Central'),storage);
});
test('sin almacenamiento no se reemplaza por cuarentena ni tránsito',()=>{
  assert.equal(select([{type:'QUARANTINE'},{type:'TRANSIT'}])('Central'),null);
});
test('un tipo solicitado no se reemplaza por almacenamiento',()=>{
  assert.equal(select([{type:'STORAGE'}])('Central','QUARANTINE'),null);
});
test('las ubicaciones deshabilitadas no se seleccionan',()=>{
  const enabled={type:'STORAGE',active:true};
  assert.equal(select([{type:'STORAGE',active:false},enabled])('Central'),enabled);
  assert.equal(select([{type:'STORAGE',active:false}])('Central'),null);
});
test('una bodega desconocida no recibe una ubicación de otra bodega',()=>{
  assert.equal(select([{type:'STORAGE'}])('Otra'),null);
});
