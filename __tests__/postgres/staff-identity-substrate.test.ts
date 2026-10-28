import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { staffIdentitySubstrateSql, FROZEN_0076_SHA256 } from "../../lib/staff-identity-substrate-schema.mjs";
import { inspectStaffIdentitySubstrate, readStaffIdentitySubstrateCatalogue } from "../../lib/staff-identity-substrate-probe.mjs";
assertRealPostgresUrl();
const schema=`aqlan_identity_${randomBytes(8).toString("hex")}`;
const client=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
beforeAll(async()=>{
 await client.connect();
 await client.query(`CREATE SCHEMA ${schema}`);
 await client.query(`SET search_path TO ${schema},pg_catalog`);
 await client.query(`CREATE TABLE ${schema}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);
 CREATE TABLE ${schema}.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB)`);
 const frozen=readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql",import.meta.url),"utf8");
 expect(createHash("sha256").update(frozen).digest("hex")).toBe(FROZEN_0076_SHA256);
 await client.query(frozen);
 await client.query(staffIdentitySubstrateSql(schema));
});
afterAll(async()=>{await client.query(`DROP SCHEMA ${schema} CASCADE`);await client.end();});
it("exact catalog matches frozen reviewed contract without provisioning",async()=>{
 const actual=await readStaffIdentitySubstrateCatalogue(client,schema);
 expect(await inspectStaffIdentitySubstrate(client,schema)).toMatchObject({version:1,schema});
 expect(actual.relations).toHaveLength(8);
});

import { initializeStaffIdentitySubstrate, readStaffIdentitySubstrate, bindStaffAccountIncarnation, retireStaffAccountIncarnation, advanceStaffIdentityTargetGeneration, assertStaffIdentitySourceRestoreAllowed } from "../../lib/staff-identity-substrate.mjs";
const expectation=(h:{generationId:string;registryRevision:string})=>({generationId:h.generationId,registryRevision:h.registryRevision});
async function tx<T>(work:()=>Promise<T>){await client.query("BEGIN");try{const result=await work();await client.query("COMMIT");return result;}catch(e){await client.query("ROLLBACK");throw e;}}
it("initializes only empty storage in quarantine without owner/grants or account modification",async()=>{
 await client.query(`INSERT INTO ${schema}.users(id,username,role,is_active) VALUES(1,'synthetic','admin',TRUE)`);
 const before=(await client.query(`SELECT * FROM ${schema}.users ORDER BY id`)).rows;
 const control=(await client.query(`SELECT * FROM ${schema}.staff_authority_control`)).rows;
 const h=await tx(()=>initializeStaffIdentitySubstrate(client,schema));
 expect(h).toMatchObject({status:"quarantined",authorizesSessions:false,registryRevision:"1"});
 expect((await client.query(`SELECT * FROM ${schema}.users ORDER BY id`)).rows).toEqual(before);
 expect((await client.query(`SELECT * FROM ${schema}.staff_authority_control`)).rows).toEqual(control);
 await expect(tx(()=>initializeStaffIdentitySubstrate(client,schema))).rejects.toThrow("STAFF_IDENTITY_INITIALIZATION_REFUSED");
});
it("explicit old-binding and target-generation CAS mints a fresh subject, never a role grant",async()=>{
 const h=await tx(()=>readStaffIdentitySubstrate(client,schema));
 const b=await tx(()=>bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:null,expected:expectation(h)},schema));
 expect(b.subjectId).toMatch(/^[a-f0-9-]{36}$/);expect(b.authorizesSessions).toBe(false);
 expect((await client.query(`SELECT authorization_mode,permissions FROM ${schema}.users WHERE id=1`)).rows[0]).toEqual({authorization_mode:"legacy",permissions:null});
 await expect(tx(()=>bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:null,expected:expectation(h)},schema))).rejects.toThrow("STAFF_IDENTITY_STALE_CAS");
 await expect(tx(()=>bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:null,expected:expectation(b)},schema))).rejects.toThrow("STAFF_IDENTITY_STALE_CAS");
});
it("rollback and savepoint rollback remove every attempted binding and registry increment",async()=>{
 const before=await tx(()=>readStaffIdentitySubstrate(client,schema));
 const [{subject_id:old}]=(await client.query(`SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1`)).rows;
 const count=await client.query(`SELECT count(*)::int AS n FROM ${schema}.staff_identity_subjects`);
 await client.query("BEGIN");await client.query("SAVEPOINT synthetic_before_binding");
 const b=await bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:old,expected:expectation(before)},schema);
 expect(b.subjectId).not.toBe(old);
 await client.query("ROLLBACK TO SAVEPOINT synthetic_before_binding");
 expect(await readStaffIdentitySubstrate(client,schema)).toEqual(before);
 await client.query("ROLLBACK");
 expect((await client.query(`SELECT count(*)::int AS n FROM ${schema}.staff_identity_subjects`)).rows).toEqual(count.rows);
});
it("retirement preserves immutable tombstones when numeric account ID is deleted and reused",async()=>{
 let h=await tx(()=>readStaffIdentitySubstrate(client,schema));
 const [{subject_id:old}]=(await client.query(`SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1`)).rows;
 h=await tx(()=>retireStaffAccountIncarnation(client,{userId:1,currentSubjectId:old,expected:expectation(h)},schema));
 await client.query(`DELETE FROM ${schema}.users WHERE id=1`);
 await client.query(`INSERT INTO ${schema}.users(id,username,role,is_active) VALUES(1,'replacement','reception',TRUE)`);
 const b=await tx(()=>bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:null,expected:expectation(h)},schema));
 expect(b.subjectId).not.toBe(old);
 expect((await client.query(`SELECT subject_id FROM ${schema}.staff_identity_subjects WHERE subject_id=$1`,[old])).rows).toHaveLength(1);
 await expect(tx(()=>client.query(`UPDATE ${schema}.staff_identity_current SET subject_id=$1 WHERE user_id=1`,[old]))).rejects.toThrow();
});
it.each(["reset","restore"] as const)("%s rotates target generation only, retains history and quarantine, refuses stale CAS",async(reason)=>{
 const before=await tx(()=>readStaffIdentitySubstrate(client,schema));
 const history=(await client.query(`SELECT * FROM ${schema}.staff_identity_subjects ORDER BY subject_id`)).rows;
 const bindings=(await client.query(`SELECT * FROM ${schema}.staff_identity_current ORDER BY user_id`)).rows;
 const next=await tx(()=>advanceStaffIdentityTargetGeneration(client,{expected:expectation(before),reason},schema));
 expect(next.generationId).not.toBe(before.generationId);expect(next.realmId).toBe(before.realmId);expect(next.status).toBe("quarantined");
 expect((await client.query(`SELECT * FROM ${schema}.staff_identity_subjects ORDER BY subject_id`)).rows).toEqual(history);
 expect((await client.query(`SELECT * FROM ${schema}.staff_identity_current ORDER BY user_id`)).rows).toEqual(bindings);
 await expect(tx(()=>advanceStaffIdentityTargetGeneration(client,{expected:expectation(before),reason},schema))).rejects.toThrow("STAFF_IDENTITY_STALE_CAS");
});
it("autocommit and stale isolation are refused, no retained client authority after new BEGIN",async()=>{
 await expect(readStaffIdentitySubstrate(client,schema)).rejects.toThrow();
 await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
 await expect(readStaffIdentitySubstrate(client,schema)).rejects.toThrow("STAFF_IDENTITY_TRANSACTION_REQUIRED");await client.query("ROLLBACK");
 const old=await tx(()=>readStaffIdentitySubstrate(client,schema));
 await tx(()=>advanceStaffIdentityTargetGeneration(client,{expected:expectation(old),reason:"reset"},schema));
 await expect(tx(()=>advanceStaffIdentityTargetGeneration(client,{expected:expectation(old),reason:"reset"},schema))).rejects.toThrow("STAFF_IDENTITY_STALE_CAS");
});
it("two contenders serialize and exactly one stale expected-revision operation can commit",async()=>{
 const before=await tx(()=>readStaffIdentitySubstrate(client,schema));
 const other=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});await other.connect();
 await client.query("BEGIN");await other.query("BEGIN");
 let pending:Promise<unknown>|undefined;
 try{
  const first=await advanceStaffIdentityTargetGeneration(client,{expected:expectation(before),reason:"reset"},schema);
  pending=advanceStaffIdentityTargetGeneration(other,{expected:expectation(before),reason:"reset"},schema).then(value=>({value}),error=>({error}));
  await client.query("COMMIT");
  expect(await pending).toMatchObject({error:{message:"STAFF_IDENTITY_STALE_CAS"}});
  await other.query("ROLLBACK");expect((await tx(()=>readStaffIdentitySubstrate(client,schema))).generationId).toBe(first.generationId);
 }finally{await client.query("ROLLBACK");await other.query("ROLLBACK");await pending;await other.end();}
});
it.each([
 "ALTER TABLE SCHEMA.staff_identity_subjects DISABLE TRIGGER staff_identity_subjects_immutable",
 "ALTER TABLE SCHEMA.staff_identity_subjects ADD COLUMN unexpected TEXT",
 "ALTER TABLE SCHEMA.staff_identity_state DROP CONSTRAINT staff_identity_state_status_check",
 "ALTER FUNCTION SCHEMA.staff_identity_history_guard() SET search_path TO public",
 "CREATE TABLE SCHEMA.staff_execution_epochs(id INTEGER)",
 "DROP TABLE SCHEMA.staff_identity_current",
])("strict probe refuses drift or parallel schema without repair: %s",async(sql)=>{
 await client.query("BEGIN");try{
  await client.query(sql.replaceAll("SCHEMA",schema));
  await expect(inspectStaffIdentitySubstrate(client,schema)).rejects.toThrow(/STAFF_IDENTITY_(SCHEMA_DRIFT|PARALLEL_SCHEMA_REFUSED)/);
 }finally{await client.query("ROLLBACK");}
 expect((await inspectStaffIdentitySubstrate(client,schema)).version).toBe(1);
});
it("function body replacement and forged view names cannot impersonate known schema",async()=>{
 await client.query("BEGIN");try{
  await client.query(`CREATE OR REPLACE FUNCTION ${schema}.staff_identity_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog,${schema} AS $$ BEGIN RETURN NEW; END $$`);
  await expect(inspectStaffIdentitySubstrate(client,schema)).rejects.toThrow("STAFF_IDENTITY_SCHEMA_DRIFT");
 }finally{await client.query("ROLLBACK");}
 await client.query("BEGIN");try{
  await client.query(`DROP TABLE ${schema}.staff_identity_current;CREATE VIEW ${schema}.staff_identity_current AS SELECT 1 AS user_id`);
  await expect(inspectStaffIdentitySubstrate(client,schema)).rejects.toThrow("STAFF_IDENTITY_SCHEMA_DRIFT");
 }finally{await client.query("ROLLBACK");}
});
it("all source restore payloads remain unsupported, never target authority or owner continuity",async()=>{
 const before=await tx(()=>readStaffIdentitySubstrate(client,schema));
 for(const payload of [null,{},[],{staff_authority_control:[{state:"active",owner_user_id:1}]},{staff_identity_current:[]},{authority:{realmId:before.realmId}},{durableIdentity:{generationId:before.generationId}}])
  expect(()=>assertStaffIdentitySourceRestoreAllowed(payload)).toThrow("STAFF_IDENTITY_SOURCE_RESTORE_UNSUPPORTED");
 expect(await tx(()=>readStaffIdentitySubstrate(client,schema))).toEqual(before);
});

it.each(["orphan-subject", "missing-current", "unaccounted-revision"])("persisted %s is refused without adopting or repairing it",async(kind)=>{
 const broken=`aqlan_identity_${randomBytes(8).toString("hex")}`;
 await client.query(`CREATE SCHEMA ${broken}`);
 try {
  await client.query(`SET search_path TO ${broken},pg_catalog`);
  await client.query(`CREATE TABLE ${broken}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);
   CREATE TABLE ${broken}.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB)`);
  await client.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql",import.meta.url),"utf8"));
  await client.query(staffIdentitySubstrateSql(broken));
  await client.query(`INSERT INTO ${broken}.users(id) VALUES(1)`);
  const h=await tx(()=>initializeStaffIdentitySubstrate(client,broken));
  const subject=randomUUID();
  await tx(async()=>{
   await client.query(`UPDATE ${broken}.staff_identity_state SET registry_revision=2 WHERE singleton`);
   if(kind!=="unaccounted-revision")await client.query(`INSERT INTO ${broken}.staff_identity_subjects(subject_id,realm_id,user_id_at_binding,created_generation_id,created_registry_revision) VALUES($1,$2,1,$3,2)`,[subject,h.realmId,h.generationId]);
   if(kind==="missing-current")await client.query(`INSERT INTO ${broken}.staff_identity_binding_events(registry_revision,generation_id,user_id,new_subject_id) VALUES(2,$1,1,$2)`,[h.generationId,subject]);
  });
  // The raw privileged transaction committed. Public lifecycle entry must not
  // adopt it; SQL shape constraints alone do not guarantee cycle completeness.
  await expect(tx(()=>readStaffIdentitySubstrate(client,broken))).rejects.toThrow("STAFF_IDENTITY_HISTORY_INTEGRITY");
  await expect(tx(()=>bindStaffAccountIncarnation(client,{userId:1,currentSubjectId:null,expected:{generationId:h.generationId,registryRevision:"2"}},broken))).rejects.toThrow("STAFF_IDENTITY_HISTORY_INTEGRITY");
  await expect(tx(()=>retireStaffAccountIncarnation(client,{userId:1,currentSubjectId:subject,expected:{generationId:h.generationId,registryRevision:"2"}},broken))).rejects.toThrow("STAFF_IDENTITY_HISTORY_INTEGRITY");
  await expect(tx(()=>advanceStaffIdentityTargetGeneration(client,{reason:"reset",expected:{generationId:h.generationId,registryRevision:"2"}},broken))).rejects.toThrow("STAFF_IDENTITY_HISTORY_INTEGRITY");
  await expect(tx(()=>initializeStaffIdentitySubstrate(client,broken))).rejects.toThrow("STAFF_IDENTITY_INITIALIZATION_REFUSED");
  expect((await client.query(`SELECT subject_id FROM ${broken}.staff_identity_subjects`)).rows).toEqual(kind==="unaccounted-revision"?[]:[{subject_id:subject}]);
  expect((await client.query(`SELECT * FROM ${broken}.staff_identity_current`)).rows).toEqual([]);
 }finally{
  await client.query(`SET search_path TO ${schema},pg_catalog`);
  await client.query(`DROP SCHEMA ${broken} CASCADE`);
 }
});
