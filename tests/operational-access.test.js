import test from "node:test";
import assert from "node:assert/strict";
import { enforceOperationalOrganization } from "../lib/operational-access.js";

test("la operación sin organización adopta la configurada en el servidor",()=>{
  const body={warehouseId:"warehouse",quantity:1};
  assert.equal(enforceOperationalOrganization(body,"org").organizationId,"org");
  assert.equal(body.warehouseId,"warehouse");
});

test("la organización legítima conserva compatibilidad con los formularios existentes",()=>{
  assert.equal(enforceOperationalOrganization({organizationId:"ORG"},"org").organizationId,"org");
  for(const value of [null,undefined,""]){
    assert.equal(enforceOperationalOrganization({organizationId:value},"org").organizationId,"org");
  }
});

test("un identificador de otra organización se rechaza sin modificar la solicitud",()=>{
  const body={organizationId:"other",quantity:1};
  assert.throws(()=>enforceOperationalOrganization(body,"org"),error=>
    error.status===403 && error.code==="ORGANIZATION_SCOPE_DENIED");
  assert.equal(body.organizationId,"other");
});
