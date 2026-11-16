import { beforeAll, afterAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { createSessionToken, readSessionToken, legacySessionEvidence, sessionCredentialVersion } from "../../lib/auth";
import { readLegacyStaffSchema, assertLegacyStaffWrite, finishLegacyStaffWrite } from "../../lib/legacy-staff-boundary";
assertRealPostgresUrl();
const schema=`aqlan_identity_${randomBytes(8).toString("hex")}`;
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false,max:5});
const canonical=JSON.stringify({schemaVersion:2,confirmation:"owner",revision:1,patientScope:"none",appointmentScope:"none",grants:{}});
function authorization(){const parsed=readSessionToken(createSessionToken({userId:1,username:"synthetic-admin",role:"admin",expiresAt:Date.now()+60_000,credentialVersion:sessionCredentialVersion("synthetic-hash")}))!;return {evidence:legacySessionEvidence(parsed)!};}
async function tx<T>(work:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query("BEGIN");const value=await work(c);await c.query("COMMIT");return value;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
beforeAll(async()=>{
 await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.parties(id INTEGER PRIMARY KEY); CREATE TABLE ${schema}.users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,is_active BOOLEAN,password_hash TEXT,permissions JSONB);INSERT INTO ${schema}.users VALUES(1,'synthetic-admin','admin',TRUE,'synthetic-hash',NULL),(2,'synthetic-target','doctor',TRUE,'target-hash',NULL)`);
});
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
it("ordinary base permits genuine original proof and rejects missing/copied evidence",async()=>{
 expect(await readLegacyStaffSchema(pool,schema)).toBe("base");const auth=authorization();
 await tx(async c=>{expect((await assertLegacyStaffWrite(c,auth,2,"update",schema)).targetExists).toBe(true);await finishLegacyStaffWrite(c,auth,2,schema);});
 await expect(tx(c=>assertLegacyStaffWrite(c,undefined,2,"update",schema))).rejects.toThrow("SIGNED_EVIDENCE_REQUIRED");
 await expect(tx(c=>assertLegacyStaffWrite(c,{evidence:{...auth.evidence}},2,"update",schema))).rejects.toThrow("SIGNED_EVIDENCE_REQUIRED");
});
it.each([
 "CREATE TABLE SCHEMA.staff_authority_control(id INTEGER)",
 "CREATE VIEW SCHEMA.staff_identity_state AS SELECT 1 AS singleton",
 "CREATE TABLE SCHEMA.staff_authority_identity(id INTEGER)",
 "CREATE TABLE SCHEMA.staff_execution_epochs(id INTEGER)",
 "ALTER TABLE SCHEMA.users ADD COLUMN authorization_mode TEXT",
 "ALTER TABLE SCHEMA.users ADD COLUMN authorization_epoch BIGINT",
 "ALTER TABLE SCHEMA.users ADD COLUMN staff_subject_id UUID",
 "ALTER TABLE SCHEMA.parties ADD COLUMN clinical_authority_epoch BIGINT",
 "CREATE FUNCTION SCHEMA.staff_subject_identity_immutable() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
 "CREATE FUNCTION SCHEMA.staff_identity_state_guard() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
 "CREATE INDEX users_staff_subject_identity ON SCHEMA.users(id)",
])("any exact authority footprint is a hold, never absence: %s",async(sql)=>{
 const c=await pool.connect();await c.query("BEGIN");try{await c.query(sql.replaceAll("SCHEMA",schema));await expect(readLegacyStaffSchema(c,schema)).rejects.toThrow("AUTHORITY_SCHEMA_HELD");}finally{await c.query("ROLLBACK");c.release();}
});
it("unrelated HR names do not trigger a broad staff-prefix hold",async()=>{
 await tx(async c=>{await c.query(`CREATE FUNCTION ${schema}.staff_hr_preview() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);expect(await readLegacyStaffSchema(c,schema)).toBe("base");});
});
it.each([1,2])("raw canonical actor/target %s cannot pass bare-base legacy mapping",async(id)=>{
 await pool.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=$2`,[canonical,id]);
 try{await expect(tx(c=>assertLegacyStaffWrite(c,authorization(),2,"update",schema))).rejects.toThrow("PERMISSION_ENVELOPE_HELD");}finally{await pool.query(`UPDATE ${schema}.users SET permissions=NULL WHERE id=$1`,[id]);}
});
it.each([1,2])("conversion of actor/target %s during a real fence wait is observed fresh",async(id)=>{
 const auth=authorization(),holder=await pool.connect();await holder.query("BEGIN");const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${schema}`]);
 let wrote=false;
 const pending=tx(async c=>{await assertLegacyStaffWrite(c,auth,2,"update",schema);wrote=true;}).then(()=>null,e=>e);
 try{
  const deadline=performance.now()+3000;let blocked=false;
  while(performance.now()<deadline){const {rows}=await pool.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[pid]);if(rows.length){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  expect(blocked).toBe(true);await holder.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=$2`,[canonical,id]);await holder.query("COMMIT");
  expect(await pending).toMatchObject({message:"LEGACY_STAFF_PERMISSION_ENVELOPE_HELD"});expect(wrote).toBe(false);
 }finally{await holder.query("ROLLBACK");holder.release();await pending;await pool.query(`UPDATE ${schema}.users SET permissions=NULL WHERE id=$1`,[id]);}
});
