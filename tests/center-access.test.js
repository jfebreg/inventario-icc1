import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const server=await readFile(new URL("../server.js",import.meta.url),"utf8");
function helper(name,next,pool){
  const source=server.slice(server.indexOf(`async function ${name}(`),server.indexOf(next,server.indexOf(`async function ${name}(`)));
  return runInNewContext(`${source}; ${name}`,{pool,logisticsOrganizationId:"icc"});
}
const warehouse=(pool)=>helper("profileMayAccessWarehouse","async function deviceReadinessOverview",pool);
const location=(pool)=>helper("profileMayAccessLocation","async function syncInventoryAdjustmentTask",pool);

test("perfiles deshabilitados o sin centro no obtienen acceso operativo",async()=>{
  let calls=0;
  const pool={query:async()=>{calls++;return {rowCount:1};}};
  for(const access of [warehouse(pool),location(pool)]){
    assert.equal(await access({admin:true,active:false},"id"),false);
    assert.equal(await access({admin:false},"id"),false);
    assert.equal(await access(null,"id"),false);
  }
  assert.equal(calls,0);
});

test("las bodegas se consultan con centro y organización del servidor",async()=>{
  const pool={query:async(sql,params)=>{
    assert.deepEqual(Array.from(params),["warehouse","Obra Túnel","icc"]);
    assert.match(sql,/w.organization_id=\$3/);
    assert.match(sql,/w.active=TRUE/);
    assert.match(sql,/cc.active=TRUE AND cc.organization_id=\$3/);
    return {rowCount:0};
  }};
  assert.equal(await warehouse(pool)({cost_center:"Obra Túnel"},"warehouse"),false);
});

test("la ubicación exige bodega activa y misma organización",async()=>{
  const pool={query:async(sql,params)=>{
    assert.deepEqual(Array.from(params),["location","Obra Túnel","icc"]);
    assert.match(sql,/loc.active=TRUE AND w.active=TRUE/);
    assert.match(sql,/loc.organization_id=\$3 AND w.organization_id=\$3/);
    assert.match(sql,/cc.active=TRUE AND cc.organization_id=\$3/);
    return {rowCount:1};
  }};
  assert.equal(await location(pool)({cost_center:"Obra Túnel"},"location"),true);
});

test("la administración activa conserva su alcance entre centros",async()=>{
  const pool={query:async()=>{throw new Error("No debe restringir por centro al administrador");}};
  assert.equal(await warehouse(pool)({admin:true,active:true},"warehouse"),true);
  assert.equal(await location(pool)({admin:true,active:true},"location"),true);
});
test("sin coincidencia de centro activo y organización se deniega la ubicación",async()=>{
  const pool={query:async(sql)=>{
    assert.match(sql,/cc.active=TRUE AND cc.organization_id=\$3/);
    return {rowCount:0};
  }};
  assert.equal(await location(pool)({active:true,cost_center:"Centro deshabilitado"},"location"),false);
});

test("un perfil deshabilitado pierde también los permisos de rol",()=>{
  const source=server.slice(server.indexOf("function profileCan("),server.indexOf("async function securityGovernanceOverview"));
  const can=runInNewContext(`${source};profileCan`,{KNOWN_PERMISSIONS:new Set(["move","approve"])});
  assert.equal(can({admin:true,active:false},"approve"),false);
  assert.equal(can({permissions:["move"],active:false},"move"),false);
  assert.equal(can({permissions:["move"],active:true},"move"),true);
});
