import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const dir=new URL('../migrations/',import.meta.url);
const migration=await readFile(new URL('080_security_advisor_hardening.sql',dir),'utf8');
const server=await readFile(new URL('../server.js',import.meta.url),'utf8');
const logistics=await readFile(new URL('../lib/logistics.js',import.meta.url),'utf8');

test('las tres vistas pasan a invoker y no se exponen a clientes',()=>{
  for(const name of ['logistics_stock_on_hand','logistics_company_stock','logistics_audit_chain_verification']){
    assert.ok(migration.includes(`ALTER VIEW public.${name} SET (security_invoker = true)`));
  }
  assert.match(migration,/REVOKE ALL ON public.logistics_stock_on_hand,[\s\S]*?FROM PUBLIC, anon, authenticated/);
});
test('las tablas internas tienen RLS y el arranque conserva el cierre',()=>{
  for(const name of ['inventory_auth_settings','logistics_schema_migrations'])assert.ok(migration.includes(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`));
  assert.match(server,/const serverOnlyTables = \[\s*"inventory_auth_settings"/);
  assert.match(logistics,/ALTER TABLE logistics_schema_migrations ENABLE ROW LEVEL SECURITY/);
  assert.match(logistics,/REVOKE ALL ON logistics_schema_migrations FROM PUBLIC, anon, authenticated/);
});
test('anon pierde RPC de permisos pero authenticated conserva los helpers de RLS',()=>{
  for(const source of [server,migration]){
    assert.match(source,/REVOKE ALL ON FUNCTION public.inventory_is_admin\(\), public.inventory_user_center\(\) FROM PUBLIC, anon/);
    assert.match(source,/GRANT EXECUTE ON FUNCTION public.inventory_is_admin\(\), public.inventory_user_center\(\) TO authenticated/);
  }
  assert.match(server,/SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp/);
});
test('la lista de hardening contiene los 25 triggers propios existentes',async()=>{
  const names=[...migration.matchAll(/'((?:logistics|inventory)_[a-z_]+)'/g)].map(x=>x[1]).filter(name=>name!=='custody_assignment');
  assert.equal(names.length,25);
  assert.equal(new Set(names).size,25);
  let all='';
  for(const file of await readdir(dir))if(file.endsWith('.sql')&&file!=='080_security_advisor_hardening.sql')all+=await readFile(new URL(file,dir),'utf8');
  for(const name of names)assert.ok(all.includes(`FUNCTION ${name}()`),name);
  assert.match(migration,/p.prorettype='pg_catalog.trigger'::regtype/);
  assert.match(migration,/IF hardened <> 25 THEN/);
  assert.match(migration,/search_path = pg_catalog, public, extensions, pg_temp/);
  assert.match(migration,/REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated/);
});
test('mover pg_trgm no deja consultas del servidor con similarity sin esquema',()=>{
  assert.match(migration,/ALTER EXTENSION pg_trgm SET SCHEMA extensions/);
  assert.match(migration,/n.nspname <> 'extensions'/);
  assert.equal([...logistics.matchAll(/extensions\.similarity\(/g)].length,4);
  assert.equal(/(?<!\.)\bsimilarity\(/.test(logistics),false);
});
