import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustodyAssignment} from '../lib/logistics.js';

function fixture(worker){
  const calls=[];
  let released=false;
  const client={release(){released=true},async query(sql){
    calls.push(sql);
    if(['BEGIN','ROLLBACK','COMMIT'].includes(sql))return{rows:[]};
    if(sql.includes('FROM logistics_custody_assignments'))return{rows:[]};
    if(sql.includes('FROM logistics_items'))return{rows:[{id:'item',active:true,item_type:'CONSUMABLE',tracking_type:'QUANTITY'}]};
    if(sql.includes('FROM logistics_warehouses'))return{rows:[{id:'warehouse',cost_center:'Central'}]};
    if(sql.includes('FROM inventory_worker_enrollments')){
      assert.match(sql,/status<>'Inactivo'/);
      return{rows:worker?[worker]:[]};
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  }};
  return{pool:{connect:async()=>client},calls,isReleased:()=>released};
}
const input={organizationId:'org',itemId:'item',warehouseId:'warehouse',workerId:'worker',quantity:1,externalReference:'delivery-test'};

test('no entrega a un trabajador de otro centro ni escribe stock',async()=>{
  const f=fixture({id:'worker',cost_center:'Otra obra'});
  await assert.rejects(createCustodyAssignment(f.pool,input,'issuer'),/no pertenece al centro/);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.equal(f.calls.some(sql=>/INSERT|UPDATE|DELETE/.test(sql)),false);
  assert.equal(f.calls.includes('COMMIT'),false);
  assert.equal(f.isReleased(),true);
});
test('trabajador inexistente o excluido por inactividad no crea una entrega',async()=>{
  const f=fixture(null);
  await assert.rejects(createCustodyAssignment(f.pool,input,'issuer'),/no enrolado o inactivo/);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.equal(f.calls.some(sql=>/INSERT|UPDATE|DELETE/.test(sql)),false);
  assert.equal(f.isReleased(),true);
});
test('un trabajador sin centro no puede recibir desde una bodega con centro',async()=>{
  const f=fixture({id:'worker',cost_center:null});
  await assert.rejects(createCustodyAssignment(f.pool,input,'issuer'),/no pertenece al centro/);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.equal(f.calls.some(sql=>/INSERT|UPDATE|DELETE/.test(sql)),false);
});
