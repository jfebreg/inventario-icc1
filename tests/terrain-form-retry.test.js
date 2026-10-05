import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const register=app.slice(app.indexOf('async function registerTerrainV2('),app.indexOf('function logisticsPanelMarkup('));
const attempt=app.slice(app.indexOf('function validateMovementInput('),app.indexOf('async function movementSubmit('));
function setup(fetch,worker={id:'worker'}){
  let n=0;
  return runInNewContext(`${register}\n${attempt}\n({runMovementAttempt,registerTerrainV2})`,{
    activeUserId:'user',crypto:{randomUUID:()=>`uuid-${++n}`},logisticsV2:{loaded:true,status:{organizationId:'org'}},
    loadLogisticsV2:async()=>{},canonicalItemForAsset:()=>({id:'item'}),canonicalUnitForAsset:()=>null,
    canonicalWarehouse:()=>({id:'warehouse'}),canonicalLocation:()=>({id:'location'}),canonicalWorker:()=>worker,
    fefoAllocations:(_item,_location,qty)=>[{lotId:null,quantity:qty}],logisticsFetch:fetch
  });
}
const payload={assetId:'asset',qty:1,from:'Central',worker:'Persona',email:'worker@example.com',notes:'Entrega',userId:'user'};
function submit(api,form,p=payload){return api.runMovementAttempt(form,p,(id,onRequest)=>api.registerTerrainV2({...p,a:{code:'SKU',type:'Consumible'},legacyId:id,acceptanceToken:`cargo-${id}`,onRequest}));}
test('la entrega conserva referencia y token de aceptación al perder la respuesta',async()=>{
  const bodies=[],api=setup(async(_url,options)=>{bodies.push(options.body);if(bodies.length===1)throw new Error('Timeout');return{assignment:{id:'custody'}}}),form={dataset:{}};
  await assert.rejects(submit(api,form),/Timeout/);
  const result=await submit(api,form);
  assert.equal(result.custodyId,'custody');
  assert.equal(bodies[0],bodies[1]);
  assert.ok(JSON.parse(bodies[0]).acceptanceToken.startsWith('cargo-muuid-'));
});
test('una entrega incierta no permite cambiar al trabajador',async()=>{
  let calls=0;
  const api=setup(async()=>{calls++;throw new Error('Timeout')}),form={dataset:{}};
  await assert.rejects(submit(api,form));
  await assert.rejects(submit(api,form,{...payload,worker:'Otra persona'}),/pendiente de confirmar/);
  assert.equal(calls,1);
});
test('la validación local de trabajador libera una entrega todavía no enviada',async()=>{
  let calls=0;
  const api=setup(async()=>{calls++},null),form={dataset:{}};
  await assert.rejects(submit(api,form),/debe estar enrolado/);
  assert.equal(calls,0);
  assert.equal(form.dataset.movementAttemptId,undefined);
});
