import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustodyAssignment} from '../lib/logistics.js';
const input={organizationId:'org',itemId:'item',workerId:'worker',warehouseId:'warehouse',quantity:2,externalReference:'key',notes:'Entrega autorizada'};
function fixture({audit=true}={}){
  const calls=[];
  const assignment={id:'assignment',item_id:'item',worker_id:'worker',warehouse_id:'warehouse',asset_unit_id:null,lot_id:null,quantity:'2.0000',issued_by:'issuer',notes:input.notes,status:'RETURNED'};
  const client={release(){},async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('FROM logistics_custody_assignments'))return{rows:[assignment]};
    if(sql.includes('FROM logistics_audit_events')){
      assert.match(sql,/ORDER BY occurred_at ASC,id ASC/);
      assert.deepEqual(params,['org','assignment']);
      return{rows:audit?[{notes:input.notes}]:[]};
    }
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return{rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  }};
  return{pool:{connect:async()=>client},calls,assignment};
}
test('un reintento idéntico recupera la entrega incluso si su estado ya cambió',async()=>{
  const f=fixture(),result=await createCustodyAssignment(f.pool,input,'issuer');
  assert.equal(result.replayed,true);
  assert.equal(result.assignment,f.assignment);
  assert.equal(f.calls[1].params[0],'custody-key:org:key');
  assert.equal(f.calls.some(x=>/INSERT|UPDATE|DELETE/.test(x.sql)),false);
});
test('reutilizar referencia con datos distintos rechaza sin nuevas escrituras',async()=>{
  for(const change of [{itemId:'other'},{workerId:'other'},{warehouseId:'other'},{quantity:3},{assetUnitId:'unit'},{lotId:'lot'},{notes:'Otro motivo'}]){
    const f=fixture();
    await assert.rejects(createCustodyAssignment(f.pool,{...input,...change},'issuer'),e=>e.status===409&&e.code==='IDEMPOTENCY_CONFLICT');
    assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
    assert.equal(f.calls.some(x=>/INSERT|UPDATE|DELETE/.test(x.sql)),false);
  }
});
test('otro emisor no puede apropiarse de una referencia de entrega',async()=>{
  const f=fixture();
  await assert.rejects(createCustodyAssignment(f.pool,input,'other'),e=>e.status===409&&e.code==='IDEMPOTENCY_CONFLICT');
});
test('las notas agregadas al devolver no invalidan el reintento original',async()=>{
  const f=fixture();
  f.assignment.notes=`${input.notes}\nDevolución registrada por Julio`;
  const result=await createCustodyAssignment(f.pool,input,'issuer');
  assert.equal(result.replayed,true);
  assert.equal(result.assignment.notes,f.assignment.notes);
  assert.equal(f.calls.some(x=>/INSERT|UPDATE|DELETE/.test(x.sql)),false);
});
test('sin evidencia histórica no se compara contra las notas mutables ni se reescriben',async()=>{
  const f=fixture({audit:false});
  f.assignment.notes='Entrega histórica y devolución';
  assert.equal((await createCustodyAssignment(f.pool,input,'issuer')).replayed,true);
  assert.equal(f.calls.some(x=>/INSERT|UPDATE|DELETE/.test(x.sql)),false);
});
