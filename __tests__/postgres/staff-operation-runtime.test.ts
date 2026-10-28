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
import { withStaffOperation, assertStaffOperation, type StaffOperationHandle } from "../../lib/staff-operation-runtime";
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
 const c=await pool.connect();try{
  await c.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`);
  await c.query(`CREATE TABLE ${schema}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);CREATE TABLE ${schema}.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB);CREATE TABLE ${schema}.synthetic_runtime_effects(value TEXT)`);
  await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql",import.meta.url),"utf8"));await c.query(staffIdentitySubstrateSql(schema));
  await c.query(`INSERT INTO ${schema}.parties(id,kind,is_active) VALUES(20,'doctor',TRUE)`);
  for(const [id,role,party,grants] of [[1,"admin",null,{}],[2,"doctor",20,{"staff.view":true,"staff.permissions.edit":true}],[3,"reception",null,{}]] as const)
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
 }finally{c.release();}
});
afterAll(async()=>{vi.restoreAllMocks();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
it("active control alone cannot bypass v2 quarantine or incomplete ready anchors",async()=>{
 await expect(withStaffOperation(pool,await session(),"staff.view",async()=>{throw new Error("must not execute");},schema)).rejects.toThrow("IDENTITY_NOT_READY");
 await expect(pool.query(`UPDATE ${schema}.staff_identity_state SET status='ready'`)).rejects.toThrow();
 await expect(pool.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=2),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`)).rejects.toThrow("owner incarnation mismatch");
 await pool.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`);
 await expect(pool.query(`UPDATE ${schema}.staff_identity_state SET registry_revision=registry_revision+1`)).rejects.toThrow("separately reviewed lifecycle");
});
it("admits exact explicit capability and protected owner only in synthetic ready fixture",async()=>{
 for(const id of [1,2])await withStaffOperation(pool,await session(id),"staff.view",async(c,h)=>{await assertStaffOperation(c,h,"staff.view");},schema);
 await expect(withStaffOperation(pool,await session(3),"staff.view",async()=>{throw new Error("must not run");},schema)).rejects.toThrow("CAPABILITY_DENIED");
});
it("copied handle, wrong action/client and escaped handle never authorize",async()=>{
 let escaped:StaffOperationHandle|undefined;
 await withStaffOperation(pool,await session(),"staff.view",async(c,h)=>{
  escaped=h;await expect(assertStaffOperation(c,{...h},"staff.view")).rejects.toThrow("HANDLE_INVALID");
  await expect(assertStaffOperation(c,h,"staff.permissions.edit")).rejects.toThrow("HANDLE_INVALID");
  const other=await pool.connect();try{await expect(assertStaffOperation(other,h,"staff.view")).rejects.toThrow("HANDLE_INVALID");}finally{other.release();}
 },schema);
 const c=await pool.connect();try{await expect(assertStaffOperation(c,escaped!,"staff.view")).rejects.toThrow("HANDLE_INVALID");}finally{c.release();}
});
it("savepoint after authority fences can roll back domain writes without inventing a new XID",async()=>{
 await withStaffOperation(pool,await session(),"staff.view",async(c,h)=>{
  await c.query("SAVEPOINT domain_work");await c.query(`INSERT INTO ${schema}.synthetic_runtime_effects VALUES('rolled-back')`);await c.query("ROLLBACK TO domain_work");
  await assertStaffOperation(c,h,"staff.view");
 },schema);expect((await pool.query(`SELECT * FROM ${schema}.synthetic_runtime_effects`)).rows).toEqual([]);
});
it.each([
 `UPDATE SCHEMA.users SET password_hash='changed' WHERE id=2`,
 `UPDATE SCHEMA.users SET permissions=jsonb_set(permissions,'{revision}','2') WHERE id=2`,
 `UPDATE SCHEMA.parties SET is_active=FALSE WHERE id=20`,
 `UPDATE SCHEMA.users SET is_active=FALSE WHERE id=2`,
])("fresh precommit refusal rolls back both domain effect and authority mutation: %s",async(sql)=>{
 const before=await claims();
 await expect(withStaffOperation(pool,await session(),"staff.view",async c=>{
  await c.query(`INSERT INTO ${schema}.synthetic_runtime_effects VALUES('must-rollback')`);await c.query(sql.replaceAll("SCHEMA",schema));
 },schema)).rejects.toThrow(/STAFF_OPERATION_/);
 expect((await pool.query(`SELECT * FROM ${schema}.synthetic_runtime_effects`)).rows).toEqual([]);
 expect((await claims()).durableIdentity).toEqual(before.durableIdentity);
});
it("expiration after a write refuses actual precommit and rolls back",async()=>{
 const verified=await session();const now=Date.now();
 try{await expect(withStaffOperation(pool,verified,"staff.view",async c=>{
  await c.query(`INSERT INTO ${schema}.synthetic_runtime_effects VALUES('expired')`);vi.spyOn(Date,"now").mockReturnValue(now+120_000);
 },schema)).rejects.toThrow(/SESSION/);}finally{vi.restoreAllMocks();}
 expect((await pool.query(`SELECT * FROM ${schema}.synthetic_runtime_effects`)).rows).toEqual([]);
});
it("reused client top-level transaction change is detected and never claimed reversible",async()=>{
 await expect(withStaffOperation(pool,await session(),"staff.view",async c=>{await c.query("COMMIT");await c.query("BEGIN");},schema)).rejects.toThrow("TRANSACTION_CHANGED");
});
it.each(["subjectId","generationId","controlEpoch","accountEpoch","registryRevision","credentialVersion"])("stale signed %s cannot reach callback",async key=>{
 const p=await claims();const d={...p.durableIdentity,[key]:key.endsWith("Id")?"11111111-1111-4111-8111-111111111111":key==="credentialVersion"?"a".repeat(43):"999"};
 const verified=readVerifiedDurableSession(sign({...p,durableIdentity:d}));expect(verified).not.toBeNull();
 await expect(withStaffOperation(pool,verified!,"staff.view",async()=>{throw new Error("callback must not execute");},schema)).rejects.toThrow(/STAFF_OPERATION_/);
});

it("expiry while actually blocked by central fence prevents callback entry",async()=>{
 const p=await claims();const verified=readVerifiedDurableSession(sign(p));expect(verified).not.toBeNull();
 const holder=await pool.connect();await holder.query("BEGIN");
 const holderPid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${schema}`]);
 let called=false;
 const pending=withStaffOperation(pool,verified!,"staff.view",async()=>{called=true;},schema).then(()=>null,error=>error);
 try{
  expect((await waitForBlockedBy(holderPid)).length).toBeGreaterThan(0);
  vi.spyOn(Date,"now").mockReturnValue(p.expiresAt+1);
  await holder.query("COMMIT");
  expect(await pending).toBeInstanceOf(Error);expect(called).toBe(false);
 }finally{vi.restoreAllMocks();await holder.query("ROLLBACK");holder.release();await pending;}
});

it("schema/function drift during callback fails final admission and rolls back",async()=>{
 await expect(withStaffOperation(pool,await session(),"staff.view",async c=>{
  await c.query(`ALTER TABLE ${schema}.staff_identity_subjects DISABLE TRIGGER staff_identity_subjects_immutable`);
  await c.query(`INSERT INTO ${schema}.synthetic_runtime_effects VALUES('drift')`);
 },schema)).rejects.toThrow("SCHEMA_DRIFT");
 expect((await pool.query(`SELECT * FROM ${schema}.synthetic_runtime_effects`)).rows).toEqual([]);
});

it("signed stale username cannot supply an unchecked actor label",async()=>{
 const p=await claims();const verified=readVerifiedDurableSession(sign({...p,username:"different-synthetic-label"}));expect(verified).not.toBeNull();
 await expect(withStaffOperation(pool,verified!,"staff.view",async()=>{throw new Error("callback must not execute");},schema)).rejects.toThrow("USERNAME_STALE");
});

it("two runtime readers coexist while an exclusive lifecycle contender waits",async()=>{
 let releaseReaders!:()=>void, bothEntered!:()=>void;
 const hold=new Promise<void>(resolve=>{releaseReaders=resolve;});
 const entered=new Promise<void>(resolve=>{bothEntered=resolve;});
 const pids:number[]=[];
 const verified=await session();
 const readers=Promise.all([1,2].map(()=>withStaffOperation(pool,verified,"staff.view",async c=>{
  pids.push((await c.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  if(pids.length===2)bothEntered();await hold;
 },schema)));
 const writer=await pool.connect();let pending:Promise<void>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("runtime readers did not coexist")),3000);})]);
  if(timer)clearTimeout(timer);
  await writer.query("BEGIN");const pid=(await writer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  let acquired=false;
  pending=writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${schema}`]).then(()=>{acquired=true;});
  expect(await waitForBlockedBy(pids[0])).toContain(pid);expect(acquired).toBe(false);
  releaseReaders();await readers;await pending;expect(acquired).toBe(true);await writer.query("COMMIT");
 }finally{
  if(timer)clearTimeout(timer);releaseReaders();await readers;await pending;await writer.query("ROLLBACK");writer.release();
 }
});
it("fresh account revocation after a verified lock wait defeats the old token",async()=>{
 const verified=await session();const holder=await pool.connect();await holder.query("BEGIN");
 const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${schema}`]);
 let called=false;
 const pending=withStaffOperation(pool,verified,"staff.view",async()=>{called=true;},schema).then(()=>null,error=>error);
 try{
  await waitForBlockedBy(pid);
  await holder.query(`UPDATE ${schema}.users SET password_hash='synthetic-rotated-after-wait' WHERE id=2`);
  await holder.query("COMMIT");
  expect(await pending).toMatchObject({message:"STAFF_OPERATION_CREDENTIAL_OR_ACCOUNT_STALE"});expect(called).toBe(false);
 }finally{await holder.query("ROLLBACK");holder.release();await pending;}
 await withStaffOperation(pool,await session(),"staff.view",async()=>{},schema);
});
it("rename revokes old display claims but a fresh signed session retains immutable subject",async()=>{
 const previous=await claims();const old=readVerifiedDurableSession(sign(previous))!;
 await pool.query(`UPDATE ${schema}.users SET username='synthetic-renamed' WHERE id=2`);
 await expect(withStaffOperation(pool,old,"staff.view",async()=>{},schema)).rejects.toThrow("USERNAME_STALE");
 const fresh=await claims();expect(fresh.durableIdentity.subjectId).toBe(previous.durableIdentity.subjectId);
 await withStaffOperation(pool,readVerifiedDurableSession(sign(fresh))!,"staff.view",async()=>{},schema);
});
