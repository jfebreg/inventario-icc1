import test from "node:test";
import assert from "node:assert/strict";
import { ensureLegacyOpeningBalance } from "../lib/logistics.js";
const input={organizationId:"org",itemId:"item",quantity:18,toLocationId:"current-location",
  movementType:"OPENING",source:"LEGACY_BACKFILL",referenceId:"asset",idempotencyKey:"legacy-opening:asset:center"};

test("reiniciar conserva el saldo inicial histórico aunque el inventario actual haya cambiado",async()=>{
  const movement={id:"opening",movement_type:"OPENING",source:"LEGACY_BACKFILL",reference_id:"asset"};
  let queries=0;
  const pool={query:async(sql,params)=>{
    queries++;
    assert.deepEqual(params,["org",input.idempotencyKey]);
    return {rows:[movement]};
  },connect:async()=>{throw new Error("No debe crear otro movimiento inicial");}};
  const result=await ensureLegacyOpeningBalance(pool,input);
  assert.equal(result.replayed,true);
  assert.equal(result.movement,movement);
  assert.equal(queries,1);
});

test("la excepción histórica no acepta movimientos operativos",async()=>{
  await assert.rejects(ensureLegacyOpeningBalance({}, {...input,movementType:"RECEIPT"}),/saldos iniciales/);
});

test("la clave de migración no puede apropiarse de otra operación",async()=>{
  const pool={query:async()=>({rows:[{movement_type:"RECEIPT",source:"MANUAL",reference_id:"asset"}]})};
  await assert.rejects(ensureLegacyOpeningBalance(pool,input),/otra operación/);
});
