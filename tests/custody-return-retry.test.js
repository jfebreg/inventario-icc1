import test from 'node:test';
import assert from 'node:assert/strict';
import {returnCustodyAssignment} from '../lib/logistics.js';

function fixture(overrides={}){
  const calls=[];
  let assignment={id:'custody',organization_id:'org',item_id:'item',asset_unit_id:'unit',status:'ACTIVE',assignment_type:'ASSET_CUSTODY',...overrides};
  let releases=0;
  const client={release(){releases++},async query(sql,params){
    calls.push({sql,params});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
    if(sql.includes('FROM logistics_custody_assignments c')){
      assert.match(sql,/FOR UPDATE OF c/);
      return{rows:[{...assignment}]};
    }
    if(sql.includes('UPDATE logistics_custody_assignments')){
      assignment={...assignment,status:'RETURNED'};
      return{rows:[{...assignment}]};
    }
    if(sql.includes('UPDATE logistics_asset_units')||sql.includes('INSERT INTO logistics_audit_events')||sql.includes('INSERT INTO logistics_outbox_events'))return{rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  }};
  return{pool:{connect:async()=>client},calls,releases:()=>releases};
}
const input={idempotencyKey:'return-key',notes:'Devolución autorizada',source:'QR'};

test('devolver y reintentar libera el activo y emite eventos una sola vez',async()=>{
  const f=fixture();
  assert.equal((await returnCustodyAssignment(f.pool,'custody',input,'issuer')).replayed,false);
  const afterFirst=f.calls.length;
  assert.equal((await returnCustodyAssignment(f.pool,'custody',input,'issuer')).replayed,true);
  assert.equal(f.calls.filter(x=>x.sql.includes('UPDATE logistics_asset_units')).length,1);
  assert.equal(f.calls.filter(x=>x.sql.includes('INSERT INTO logistics_audit_events')).length,1);
  assert.equal(f.calls.filter(x=>x.sql.includes('INSERT INTO logistics_outbox_events')).length,1);
  assert.equal(f.calls.slice(afterFirst).some(x=>/^\s*(INSERT|UPDATE|DELETE)/.test(x.sql)),false);
  assert.equal(f.calls.some(x=>/logistics_stock_ledger|logistics_stock_movements/.test(x.sql)),false);
  assert.equal(f.releases(),2);
});
test('consumibles y EPP no serializados no admiten devolución de custodia',async()=>{
  for(const overrides of [{assignment_type:'CONSUMABLE_DELIVERY',status:'CONSUMED',asset_unit_id:null},{assignment_type:'PPE_DELIVERY',asset_unit_id:null}]){
    const f=fixture(overrides);
    await assert.rejects(returnCustodyAssignment(f.pool,'custody',input,'issuer'),/no admiten devolución/);
    assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
    assert.equal(f.calls.some(x=>/^\s*(INSERT|UPDATE|DELETE)/.test(x.sql)),false);
    assert.equal(f.releases(),1);
  }
});
test('una entrega no activa no libera el activo ni genera eventos',async()=>{
  const f=fixture({status:'CANCELLED'});
  await assert.rejects(returnCustodyAssignment(f.pool,'custody',input,'issuer'),/no está activa/);
  assert.equal(f.calls.some(x=>/^\s*(INSERT|UPDATE|DELETE)/.test(x.sql)),false);
  assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
});
