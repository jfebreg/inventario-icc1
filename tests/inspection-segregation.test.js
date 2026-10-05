import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { updateInspectionRun } from "../lib/logistics.js";

const migration = await readFile(new URL("../migrations/055_inspection_segregation.sql", import.meta.url), "utf8");
const logistics = await readFile(new URL("../lib/logistics.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

function finalizedInspectionPool(status="APPROVED") {
  const calls=[];
  const current={id:"inspection",status,approver_profile_id:"reviewer",inspector_profile_id:"inspector"};
  const client={query:async(sql)=>{calls.push(sql);return {rows:sql.includes("SELECT * FROM logistics_inspection_runs")?[current]:[]};},release:()=>{}};
  return {pool:{connect:async()=>client},calls,current};
}

test("el reintento del aprobador conserva el resultado final sin nuevas escrituras",async()=>{
  for(const [status,action] of [["APPROVED","APPROVE"],["CLOSED","VERIFY_CORRECTION"]]){
    const fixture=finalizedInspectionPool(status);
    const result=await updateInspectionRun(fixture.pool,"inspection",{action},"reviewer");
    assert.equal(result.replayed,true);
    assert.equal(result.inspection,fixture.current);
    assert.equal(fixture.calls.filter(sql=>/^\s*(UPDATE|INSERT)\b/.test(sql)).length,0);
    assert.ok(fixture.calls.includes("COMMIT"));
  }
});

test("otra cuenta no puede reemplazar una aprobación final",async()=>{
  const fixture=finalizedInspectionPool();
  await assert.rejects(updateInspectionRun(fixture.pool,"inspection",{action:"APPROVE"},"other-reviewer"),/no puede reemplazarse/);
  assert.ok(fixture.calls.includes("ROLLBACK"));
  assert.equal(fixture.calls.filter(sql=>/^\s*(UPDATE|INSERT)\b/.test(sql)).length,0);
});

test("una inspección finalizada no admite corrección ni regresión de etapa",async()=>{
  for(const action of ["RECORD_CORRECTION","SET_DEADLINE","APPROVE"]){
    const fixture=finalizedInspectionPool("CLOSED");
    await assert.rejects(updateInspectionRun(fixture.pool,"inspection",{action},"reviewer"),/ya está finalizada/);
    assert.equal(fixture.calls.filter(sql=>/^\s*(UPDATE|INSERT)\b/.test(sql)).length,0);
  }
});

test("PostgreSQL impide que inspector y aprobador sean la misma persona", () => {
  assert.match(migration, /logistics_inspection_run_separation/);
  assert.match(migration, /logistics_inspection_approval_separation/);
  assert.match(migration, /inspector_profile_id=NEW\.approver_profile_id/);
});

test("el servicio rechaza aprobación y verificación propias", () => {
  assert.match(logistics, /inspector no puede aprobar ni verificar su propia inspección/);
  assert.match(logistics, /current\.inspector_profile_id/);
});

test("la revisión de accesos detecta conflictos históricos", () => {
  assert.match(server, /INSPECTION_SELF_APPROVAL/);
  assert.match(server, /inspection\.inspector_profile_id=approval\.approver_profile_id/);
});

test("la interfaz avisa antes de enviar una autoaprobación", () => {
  assert.match(app, /Selecciona otro revisor/);
  assert.match(app, /inspection\?\.inspector/);
});
