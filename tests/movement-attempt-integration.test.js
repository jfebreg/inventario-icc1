import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const registerSource=app.slice(app.indexOf('async function registerMovementV2('),app.indexOf('async function registerPurchaseLineV2('));
const attemptSource=app.slice(app.indexOf('function validateMovementInput('),app.indexOf('async function movementSubmit('));
function setup({item={id:'item',sku:'SKU'},location={id:'location'},fetch}={}){
  let sequence=0;
  const context={activeUserId:'user',crypto:{randomUUID:()=>String(++sequence)},logisticsV2:{loaded:true,status:{organizationId:'org'}},
    loadLogisticsV2:async()=>{},canonicalItemForAsset:()=>item,canonicalUnitForAsset:()=>null,
    canonicalWarehouse:name=>({id:name}),canonicalLocation:()=>location,
    fefoAllocations:(_item,_location,quantity)=>[{lotId:null,quantity}],logisticsFetch:fetch};
  return runInNewContext(`${registerSource}\n${attemptSource}\n({runMovementAttempt,registerMovementV2})`,context);
}
const payload={assetId:'asset',action:'Ingreso proveedor / compra',qty:1,from:'Origen',to:'Destino',status:'Recibido',notes:''};
function submit(api,form,p=payload){return api.runMovementAttempt(form,p,(legacyId,onRequest)=>api.registerMovementV2({legacyId,onRequest,a:{id:'asset',code:'SKU',type:'Consumible'},...p}));}

test('catálogo o ubicación ausentes permiten corregir sin enviar solicitudes',async()=>{
  for(const missing of [{item:null},{location:null}]){
    let calls=0;
    const api=setup({...missing,fetch:async()=>{calls++}}),form={dataset:{}};
    await assert.rejects(submit(api,form));
    assert.equal(calls,0);
    assert.equal(form.dataset.movementAttemptId,undefined);
  }
});
test('un timeout de movimiento reutiliza exactamente el cuerpo enviado',async()=>{
  const bodies=[];
  const api=setup({fetch:async(_url,options)=>{bodies.push(options.body);if(bodies.length===1)throw new Error('Timeout');return{movement:{id:'movement'}}}}),form={dataset:{}};
  await assert.rejects(submit(api,form),/Timeout/);
  assert.ok(form.dataset.movementAttemptId);
  const result=await submit(api,form);
  assert.equal(bodies[1],bodies[0]);
  assert.equal(result.movementId,'movement');
});
test('crear traslado y fallar despacho conserva número y clave para el reintento',async()=>{
  const calls=[];
  const api=setup({fetch:async(url,options)=>{calls.push({url,body:options.body});if(url==='/api/v1/transfers')return{transfer:{id:'transfer'}};if(calls.length===2)throw Object.assign(new Error('Despacho rechazado'),{status:422});return{}}}),form={dataset:{}},p={...payload,action:'Salida de bodega',status:'En tránsito'};
  await assert.rejects(submit(api,form,p),/Despacho rechazado/);
  assert.ok(form.dataset.movementAttemptId);
  const result=await submit(api,form,p);
  assert.equal(result.transferId,'transfer');
  assert.equal(calls[0].body,calls[2].body);
  assert.equal(calls[1].body,calls[3].body);
});
