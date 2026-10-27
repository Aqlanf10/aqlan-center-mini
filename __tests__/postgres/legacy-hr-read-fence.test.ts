import { beforeAll, afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { readHrIdentityPreview } from "../../lib/hr-identity-read";
import { createSessionToken, readSessionToken, sessionCredentialVersion } from "../../lib/auth";
assertRealPostgresUrl();
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:false,max:4});
beforeAll(async()=>{
 // This suite is run alone in the fresh owned runner, not against an existing schema.
 await pool.query("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,is_active BOOLEAN,password_hash TEXT,permissions TEXT);CREATE TABLE parties(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1,'synthetic-admin','admin',TRUE,'synthetic-hash',NULL)");
});
afterAll(async()=>{await pool.end();});
it("RR snapshot starts after observed installer wait and sees newly committed authority marker",async()=>{
 const session=readSessionToken(createSessionToken({userId:1,username:"synthetic-admin",role:"admin",expiresAt:Date.now()+60_000,credentialVersion:sessionCredentialVersion("synthetic-hash")}))!;
 const holder=await pool.connect();await holder.query("BEGIN");const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
 const pending=readHrIdentityPreview(pool,session).then(()=>null,e=>e);let waiter=0;
 try{
  const deadline=performance.now()+3000;
  while(performance.now()<deadline){const {rows}=await pool.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[pid]);if(rows.length){waiter=rows[0].pid;break;}await new Promise(r=>setTimeout(r,10));}
  expect(waiter).toBeGreaterThan(0);
  await holder.query("CREATE TABLE staff_authority_control(synthetic INTEGER)");await holder.query("COMMIT");
  expect(await pending).toMatchObject({message:"LEGACY_STAFF_AUTHORITY_SCHEMA_HELD"});
  expect((await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[waiter])).rows).toEqual([]);
 }finally{await holder.query("ROLLBACK");holder.release();await pending;}
});
