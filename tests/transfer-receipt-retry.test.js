import test from "node:test";
import assert from "node:assert/strict";
import { receiveTransfer } from "../lib/logistics.js";

function replayPool(status){
  const calls=[];
  const transfer={id:"transfer",organization_id:"org",status,destination_warehouse_id:"destination"};
  const client={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes("SELECT * FROM logistics_transfer_orders"))return {rows:[transfer]};
    if(sql.includes("FROM logistics_stock_movements movement"))return {rows:[{id:"existing-receipt"}]};
    throw new Error(`Consulta inesperada en reintento: ${sql}`);
  },release:()=>{}};
  const originalQuery=client.query;
  client.query=async(sql,params)=>["BEGIN","COMMIT","ROLLBACK"].includes(sql)
    ? (calls.push({sql,params}),{rows:[]}) : originalQuery(sql,params);
  return {pool:{connect:async()=>client},calls,transfer};
}

test("repetir una recepción parcial no suma cantidades ni publica nuevos eventos",async()=>{
  const f=replayPool("PARTIALLY_RECEIVED");
  const result=await receiveTransfer(f.pool,"transfer",{idempotencyKey:"receipt-key",lines:[{lineId:"line",quantity:3}]},"receiver");
  assert.equal(result.replayed,true);
  assert.equal(result.status,"PARTIALLY_RECEIVED");
  assert.equal(f.calls.filter(x=>/^\s*(UPDATE|INSERT)\b/.test(x.sql)).length,0);
  assert.ok(f.calls.some(x=>x.sql==="COMMIT"));
});

test("el reintento se busca por organización, traslado y clave original",async()=>{
  const f=replayPool("PARTIALLY_RECEIVED");
  await receiveTransfer(f.pool,"transfer",{idempotencyKey:"receipt-key"},"receiver");
  const lookup=f.calls.find(x=>x.sql.includes("FROM logistics_stock_movements movement"));
  assert.deepEqual(lookup.params,["org","receipt-key","transfer"]);
  assert.match(lookup.sql,/movement.reference_id=\$3::text/);
  assert.match(lookup.sql,/movement.movement_type='TRANSFER_RECEIPT'/);
});

test("una recepción completa conserva respuesta idempotente al reenviarse",async()=>{
  const f=replayPool("RECEIVED");
  const result=await receiveTransfer(f.pool,"transfer",{idempotencyKey:"receipt-key"},"receiver");
  assert.equal(result.status,"RECEIVED");
  assert.equal(result.replayed,true);
});
