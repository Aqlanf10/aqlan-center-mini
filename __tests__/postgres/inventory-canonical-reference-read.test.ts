import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../../lib/staff-capability-catalogue";
/** Synthetic trusted-ready runtime evidence ONLY. This setup proves no operator,
 * owner bootstrap, source recovery or real account activation authority. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { sessionCredentialVersion } from "../../lib/auth";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { withStaffOperation, staffOperationIdentity, type StaffOperationHandle } from "../../lib/staff-operation-runtime";
import { readCanonicalInventoryReferences } from "../../lib/inventory-domain/reference-setup";
import { PURCHASE_RESET_FENCE } from "../../lib/clinic-reset";
import type { DbPool } from "../../lib/db";
assertRealPostgresUrl();
const schema=`aqlan_identity_${randomBytes(8).toString("hex")}`;
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false,max:5,options:`-c search_path=${schema},pg_catalog`});
const doc=(grants:Record<string,boolean>)=>({schemaVersion:1,revision:1,patientScope:"none",appointmentScope:"none",grants});
function sign(payload:unknown){const body=Buffer.from(JSON.stringify(payload)).toString("base64url");return `${body}.${createHmac("sha256",process.env.SESSION_SECRET!).update(body).digest("base64url")}`;}
async function claims(userId=2){
 const {rows:[r]}=await pool.query(`SELECT u.id,u.username,u.password_hash,u.authorization_epoch::text,u.permissions,u.party_id,p.clinical_authority_epoch::text,
 h.realm_id::text,h.generation_id::text,h.registry_revision::text,c.binding_epoch::text,b.subject_id::text
 FROM ${schema}.users u CROSS JOIN ${schema}.staff_identity_state h CROSS JOIN ${schema}.staff_authority_control c
 JOIN ${schema}.staff_identity_current b ON b.user_id=$1 LEFT JOIN ${schema}.parties p ON p.id=u.party_id WHERE u.id=$1`,[userId]);
 return {userId:r.id,username:r.username,expiresAt:Date.now()+60_000,durableIdentity:{schemaVersion:2,policyVersion:STAFF_AUTHORIZATION_POLICY_VERSION,realmId:r.realm_id,subjectId:r.subject_id,generationId:r.generation_id,registryRevision:r.registry_revision,controlEpoch:r.binding_epoch,accountEpoch:r.authorization_epoch,permissionRevision:r.permissions.revision,credentialVersion:sessionCredentialVersion(r.password_hash),provider:r.party_id===null?null:{partyId:r.party_id,clinicalEpoch:r.clinical_authority_epoch}}};
}
async function session(userId=2){const handle=readVerifiedDurableSession(sign(await claims(userId)));if(!handle)throw new Error("synthetic token fixture invalid");return handle;}
async function waitForBlockedBy(holderPid:number){
 const deadline=performance.now()+3000;
 while(performance.now()<deadline){
  const {rows}=await pool.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",[holderPid]);
  if(rows.length)return rows.map(r=>r.pid);
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error("real PostgreSQL blocking barrier was not observed");
}
beforeAll(async()=>{
 vi.stubEnv("INVENTORY_INTEGRATION_ENABLED","true");
 const c=await pool.connect();try{
  await c.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`);
  await c.query(`CREATE TABLE ${schema}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);CREATE TABLE ${schema}.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB);CREATE TABLE ${schema}.synthetic_runtime_effects(value TEXT)`);
  await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql",import.meta.url),"utf8"));await c.query(staffIdentitySubstrateSql(schema));
  await c.query(`INSERT INTO ${schema}.parties(id,kind,is_active) VALUES(20,'doctor',TRUE)`);
  for(const [id,role,party,grants] of [[1,"admin",null,{}],[2,"doctor",20,{"inventory.references.view":true}],[3,"admin",null,{}]] as const)
   await c.query(`INSERT INTO ${schema}.users(id,username,role,is_active,password_hash,party_id,permissions) VALUES($1,$2,$3,TRUE,'synthetic-hash',$4,$5)`,[id,`synthetic-${id}`,role,party,JSON.stringify(doc(grants))]);
  await c.query("BEGIN");let h=await initializeStaffIdentitySubstrate(c,schema);
  for(const userId of [1,2,3])h=await bindStaffAccountIncarnation(c,{userId,currentSubjectId:null,expected:{generationId:h.generationId,registryRevision:h.registryRevision}},schema);
  await c.query("COMMIT");
  await c.query(staffRuntimeSchemaSql(schema));
  // Explicit hypothetical trusted-ready fixture, not a preparation API.
  await c.query("BEGIN");
  await c.query(`UPDATE ${schema}.users SET authorization_mode='canonical'`);
  await c.query(`UPDATE ${schema}.staff_authority_control SET state='prepared',pending_owner_user_id=1,conversion_digest=repeat('a',64),recovery_reference='synthetic-runtime-evidence-not-bootstrap' WHERE singleton`);
  await c.query(`UPDATE ${schema}.staff_authority_control SET state='active',owner_user_id=1,pending_owner_user_id=NULL WHERE singleton`);
  await c.query("COMMIT");
  await expect(readCanonicalInventoryReferences(pool,await session(),"",0,schema)).rejects.toThrow("IDENTITY_NOT_READY");
  await c.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`);
  await c.query(`CREATE TABLE ${schema}.inventory_items(id INTEGER PRIMARY KEY,name TEXT,category TEXT,unit TEXT,is_active BOOLEAN);
  CREATE TABLE ${schema}.inventory_item_unit_versions(item_id INTEGER,version INTEGER,entered_unit TEXT,factor NUMERIC,entered_precision INTEGER,base_precision INTEGER);
  CREATE TABLE ${schema}.inventory_locations(id TEXT,label TEXT,kind TEXT,doctor_party_id INTEGER,is_active BOOLEAN,branch_key TEXT);
  CREATE TABLE ${schema}.inventory_approval_policies(version INTEGER,limit_minor BIGINT,allow_self_approval BOOLEAN,branch_key TEXT);
  INSERT INTO ${schema}.inventory_items SELECT n,'Item '||lpad(n::text,2,'0'),'supply','unit',TRUE FROM generate_series(1,22) n;
  INSERT INTO ${schema}.inventory_item_unit_versions VALUES(1,1,'box',10,0,0);
  INSERT INTO ${schema}.inventory_locations VALUES('store','Store','store',NULL,TRUE,'clinic'),('transit','Transit','transit',NULL,TRUE,'clinic'),('custody','Custody','custody',20,TRUE,'clinic');
  INSERT INTO ${schema}.inventory_approval_policies VALUES(1,10000,FALSE,'clinic');
  UPDATE ${schema}.parties SET name='Doctor fixture' WHERE id=20;`);
 }finally{c.release();}
});
afterAll(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
const read=async(id=2,query="",page=0)=>readCanonicalInventoryReferences(pool,await session(id),query,page,schema);
async function snapshot(){
 const {rows:tables}=await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[schema]);
 const result:Record<string,unknown>={};
 for(const {tablename} of tables)result[tablename]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${schema}."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
}
it("owner and explicit delegated grant read bounded reference DTO without any whole-row changes",async()=>{
 const before=await snapshot();
 for(const id of [1,2]){
  const dto=await read(id);expect(dto.allowedActions).toEqual(id===1?["item.create","unit.revise","location.create","policy.revise"]:[]);expect(dto.items).toHaveLength(20);expect(dto.hasMore).toBe(true);
  expect(dto.locations.map(l=>l.kind).sort()).toEqual(["custody","store","transit"]);expect(dto.doctors).toEqual([{id:20,name:"Doctor fixture"}]);
  expect(dto.policy).toEqual({version:1,limitMinor:10000,allowSelfApproval:false});
  expect(Object.keys(dto.items[0]).sort()).toEqual(["id","name","category","unit","isActive","version","enteredUnit","factor","enteredPrecision","basePrecision"].sort());
  expect(Object.isFrozen(dto.authority)).toBe(true);
 }
 expect((await read(2,"",1)).items).toHaveLength(2);expect((await read(2,"Item 01")).items).toHaveLength(1);
 expect(await snapshot()).toEqual(before);
});
it("legacy admin label and missing grant do not confer reference capability",async()=>{
 await expect(read(3)).rejects.toThrow("CAPABILITY_DENIED");
 const p=await claims();expect(readVerifiedDurableSession(sign({...p,durableIdentity:{...p.durableIdentity,policyVersion:1}}))).toBeNull();
 await expect(readCanonicalInventoryReferences(pool,{...await session()},"",0,schema)).rejects.toThrow("SESSION_OR_ACTION_INVALID");
});
it("gate and invalid search/page refuse before pool access",async()=>{
 const connect=vi.fn(()=>{throw new Error("pool must not be touched");});const forbidden={connect} as unknown as DbPool;const verified=await session();
 vi.stubEnv("INVENTORY_INTEGRATION_ENABLED","false");
 await expect(readCanonicalInventoryReferences(forbidden,verified)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
 vi.stubEnv("INVENTORY_INTEGRATION_ENABLED","true");
 for(const [query,page] of [["x".repeat(121),0],["",-1],["",5001],["",0.5]] as const)await expect(readCanonicalInventoryReferences(forbidden,verified,query,page,schema)).rejects.toThrow();
 expect(connect).not.toHaveBeenCalled();
});
it("identity projections cannot replace exact opaque handle/client/action/transaction",async()=>{
 let escaped:StaffOperationHandle|undefined;
 await withStaffOperation(pool,await session(),"inventory.references.view",async(c,h)=>{
  escaped=h;const identity=await staffOperationIdentity(c,h,"inventory.references.view");expect(Object.isFrozen(identity)).toBe(true);
  expect(Object.keys(identity).sort()).toEqual(["realmId","subjectId","generationId","userId","username","role"].sort());
  expect(identity).toMatchObject({userId:2,username:"synthetic-2",role:"doctor"});
  for(const fake of [{},{...h},identity])await expect(staffOperationIdentity(c,fake as StaffOperationHandle,"inventory.references.view")).rejects.toThrow("HANDLE_INVALID");
  await expect(staffOperationIdentity(c,h,"staff.view")).rejects.toThrow("HANDLE_INVALID");
  const other=await pool.connect();try{await expect(staffOperationIdentity(other,h,"inventory.references.view")).rejects.toThrow("HANDLE_INVALID");}finally{other.release();}
 },schema);
 const c=await pool.connect();try{await expect(staffOperationIdentity(c,escaped!,"inventory.references.view")).rejects.toThrow("HANDLE_INVALID");}finally{c.release();}
});
it.each(["subjectId","generationId","registryRevision","controlEpoch","accountEpoch","credentialVersion","permissionRevision"])("stale %s fails actual reader",async key=>{
 const p=await claims();const d={...p.durableIdentity,[key]:key.endsWith("Id")?"11111111-1111-4111-8111-111111111111":key==="credentialVersion"?"a".repeat(43):key==="permissionRevision"?999:"999"};
 const verified=readVerifiedDurableSession(sign({...p,durableIdentity:d}));expect(verified).not.toBeNull();await expect(readCanonicalInventoryReferences(pool,verified!,"",0,schema)).rejects.toThrow(/STAFF_OPERATION_/);
});
it("expiry during observed reset-fence wait refuses before reference facts",async()=>{
 const p=await claims();const verified=readVerifiedDurableSession(sign(p))!;const before=await snapshot();
 const holder=await pool.connect();await holder.query("BEGIN");const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[PURCHASE_RESET_FENCE]);
 const pending=readCanonicalInventoryReferences(pool,verified,"",0,schema).then(()=>null,e=>e);
 try{await waitForBlockedBy(pid);
  // While waiting on the later domain fence, the earlier central shared fence is held.
  const probe=await pool.connect();try{await probe.query("BEGIN");const {rows:[lock]}=await probe.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",[`aqlan.canonical.identity.substrate.v1:${schema}`]);expect(lock.acquired).toBe(false);await probe.query("ROLLBACK");}finally{probe.release();}
  vi.spyOn(Date,"now").mockReturnValue(p.expiresAt+1);await holder.query("COMMIT");expect(await pending).toMatchObject({message:"STAFF_OPERATION_SESSION_OR_ACTION_INVALID"});}
 finally{vi.restoreAllMocks();await holder.query("ROLLBACK");holder.release();await pending;}
 expect(await snapshot()).toEqual(before);
});
it("final assertion discards already-read facts after expiration",async()=>{
 const verified=await session();const before=await snapshot();const c=await pool.connect();const original=c.query.bind(c);let factsRead=false;
 const spy=vi.spyOn(c,"query").mockImplementation((async(...args:unknown[])=>{
  const result=await (original as (...a:unknown[])=>Promise<unknown>)(...args);
  if(String(args[0]).includes("SELECT version,limit_minor::text")){factsRead=true;vi.spyOn(Date,"now").mockReturnValue(Date.now()+120_000);}
  return result;
 }) as typeof c.query);
 const single={connect:async()=>c} as unknown as DbPool;
 try{await expect(readCanonicalInventoryReferences(single,verified,"",0,schema)).rejects.toThrow(/SESSION/);expect(factsRead).toBe(true);}
 finally{spy.mockRestore();vi.restoreAllMocks();}
 expect(await snapshot()).toEqual(before);
});
it("oversized lists and partial reference schema fail explicitly",async()=>{
 await pool.query(`INSERT INTO ${schema}.inventory_locations SELECT 'extra'||n,'Extra','store',NULL,TRUE,'clinic' FROM generate_series(1,498) n`);
 try{await expect(read()).rejects.toThrow("Reference list exceeds");}finally{await pool.query(`DELETE FROM ${schema}.inventory_locations WHERE id LIKE 'extra%'`);}
 await pool.query(`INSERT INTO ${schema}.parties(id,kind,name,is_active) SELECT n,'doctor','Extra',TRUE FROM generate_series(1000,1499) n`);
 try{await expect(read()).rejects.toThrow("Reference list exceeds");}finally{await pool.query(`DELETE FROM ${schema}.parties WHERE id BETWEEN 1000 AND 1499`);}
 await pool.query(`ALTER TABLE ${schema}.inventory_item_unit_versions RENAME TO hidden_units`);
 try{await expect(read()).rejects.toThrow("Reference read schema is not installed");}finally{await pool.query(`ALTER TABLE ${schema}.hidden_units RENAME TO inventory_item_unit_versions`);}
});
it("fresh DB grant revocation denies old and freshly signed sessions",async()=>{
 const old=await session();
 await pool.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=2`,[JSON.stringify(doc({}))]);
 try{
  await expect(readCanonicalInventoryReferences(pool,old,"",0,schema)).rejects.toThrow(/STAFF_OPERATION_/);
  await expect(read()).rejects.toThrow("CAPABILITY_DENIED");
 }finally{await pool.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=2`,[JSON.stringify(doc({"inventory.references.view":true}))]);}
 expect((await read()).items).toHaveLength(20);
});
it("canonical reference SQL ignores an unrelated search_path",async()=>{
 const c=await pool.connect();await c.query("SET search_path TO pg_catalog");
 const verified=await session();const single={connect:async()=>c} as unknown as DbPool;
 expect((await readCanonicalInventoryReferences(single,verified,"",0,schema)).items).toHaveLength(20);
 // withStaffOperation released the client; reset the pool connection for later use.
 const reset=await pool.connect();try{await reset.query(`SET search_path TO ${schema},pg_catalog`);}finally{reset.release();}
});
