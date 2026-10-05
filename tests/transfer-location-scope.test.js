import test from "node:test";
import assert from "node:assert/strict";
import { receiveTransfer } from "../lib/logistics.js";

function fixture(location){
  const calls=[];
  const client={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes("SELECT * FROM logistics_transfer_orders"))return {rows:[{
      id:"transfer",status:"IN_TRANSIT",destination_warehouse_id:"destination",organization_id:"org"
    }]};
    if(sql.includes("SELECT * FROM logistics_locations"))return {rows:location?[location]:[]};
    return {rows:[]};
  },release:()=>{}};
  return {pool:{connect:async()=>client},calls};
}

test("la recepción busca almacenamiento en el destino real y bloquea si no existe",async()=>{
  const f=fixture(null);
  await assert.rejects(receiveTransfer(f.pool,"transfer",{toLocationId:"foreign-location"},"receiver"),/ubicación operativa/);
  const lookup=f.calls.find(x=>x.sql.includes("SELECT * FROM logistics_locations"));
  assert.deepEqual(lookup.params,["destination","STORAGE"]);
  assert.match(lookup.sql,/active=TRUE AND location_type=\$2/);
  assert.ok(f.calls.some(x=>x.sql==="ROLLBACK"));
  assert.equal(f.calls.filter(x=>/^\s*(UPDATE|INSERT)\b/.test(x.sql)).length,0);
});

test("cuarentena y tránsito no sustituyen almacenamiento durante una recepción",async()=>{
  for(const location_type of ["QUARANTINE","TRANSIT"]){
    const f=fixture({id:"wrong-zone",location_type});
    await assert.rejects(receiveTransfer(f.pool,"transfer",{},"receiver"),/tipo requerido/);
    assert.equal(f.calls.filter(x=>/^\s*(UPDATE|INSERT)\b/.test(x.sql)).length,0);
  }
});
