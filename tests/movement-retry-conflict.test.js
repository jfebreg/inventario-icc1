import test from "node:test";
import assert from "node:assert/strict";
import { postStockMovement } from "../lib/logistics.js";

const input={organizationId:"org",itemId:"item",toLocationId:"storage",quantity:2,movementType:"RECEIPT",idempotencyKey:"key"};
function fixture(){
  const calls=[];
  const movement={id:"movement",movement_type:"RECEIPT",reference_type:null,reference_id:null,reversal_of:null};
  const client={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes("SELECT * FROM logistics_stock_movements"))return {rows:[movement]};
    if(sql.includes("FROM logistics_stock_ledger"))return {rows:[{item_id:"item",asset_unit_id:null,lot_id:null,location_id:"storage",quantity:"2.0000"}]};
    return {rows:[]};
  },release:()=>{}};
  return {pool:{connect:async()=>client},calls,movement};
}

test("reenviar el mismo movimiento conserva el registro sin nuevas escrituras",async()=>{
  const f=fixture();
  const result=await postStockMovement(f.pool,input,"operator");
  assert.equal(result.replayed,true);
  assert.equal(result.movement,f.movement);
  assert.equal(f.calls.filter(x=>/^\s*(INSERT|UPDATE)\b/.test(x.sql)).length,0);
  assert.equal(f.calls[1].params[0],"movement-key:org:key");
});

test("la clave reutilizada con otra cantidad producto ubicación o lote produce conflicto",async()=>{
  for(const change of [{quantity:3},{itemId:"other"},{toLocationId:"other"},{lotId:"other"},{assetUnitId:"other"},{movementType:"OPENING"},{referenceId:"other"}]){
    const f=fixture();
    await assert.rejects(postStockMovement(f.pool,{...input,...change},"operator"),error=>
      error.status===409 && error.code==="IDEMPOTENCY_CONFLICT");
    assert.ok(f.calls.some(x=>x.sql==="ROLLBACK"));
    assert.equal(f.calls.filter(x=>/^\s*(INSERT|UPDATE)\b/.test(x.sql)).length,0);
  }
});
