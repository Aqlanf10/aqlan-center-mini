import {beforeAll,afterAll,afterEach,it,expect,vi} from "vitest";
import {openLegacyStaffFixture} from "./_legacy-staff-fixture";
import {assertRealPostgresUrl,stubPostgresEnv} from "./_setup";
import {createSessionToken,readSessionToken,sessionCredentialVersion,type SessionPayload} from "../../lib/auth";
import {readInvoiceRevision} from "../../lib/invoice-revision-db";
import {revalidateLegacySessionReadOnlySnapshot} from "../../lib/session";
import type {QueryResult} from "../../lib/db";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
let fixture:Awaited<ReturnType<typeof openLegacyStaffFixture>>,session:SessionPayload,invoiceId:number;
const oldUrl=process.env.DATABASE_URL,fence="aqlan.canonical.identity.substrate.v1:public";
beforeAll(async()=>{
 fixture=await openLegacyStaffFixture({...process.env});process.env.DATABASE_URL=fixture.url;await db.resetPoolForTesting();await db.ensureSchema();
 const user=(await db.getPool().query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role) VALUES('preview-admin','Synthetic preview','synthetic-hash','admin') RETURNING id")).rows[0];
 session=readSessionToken(createSessionToken({userId:user.id,username:"preview-admin",role:"admin",credentialVersion:sessionCredentialVersion("synthetic-hash"),expiresAt:Date.now()+3600000}))!;
 const patient=(await db.getPool().query<{id:number}>("INSERT INTO patients(patient_number,full_name) VALUES('PREVIEW-1','Synthetic preview patient') RETURNING id")).rows[0];
 invoiceId=(await db.createInvoice({patientId:patient.id,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:null,description:"Synthetic preview",quantity:1,unitPriceMinor:1000}]}))!.id;
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{try{await db.resetPoolForTesting();await fixture?.close();}finally{process.env.DATABASE_URL=oldUrl;}});
it("reads real financial preview with every snapshot SELECT read-only and no row locks/savepoints",async()=>{
 const pool=db.getPool(),connect=pool.connect.bind(pool),seen:{sql:string;mode:string}[]=[];
 // Preserve pg Pool.query callback semantics for preflight/initialization;
 // instrumentation belongs only to the explicitly checked-out snapshot client.
 vi.spyOn(pool,"query").mockImplementation((sql,values)=>fixture.pool.query(sql,values));
 vi.spyOn(pool,"connect").mockImplementation(async()=>{
  const client=await connect(),query=client.query.bind(client);
  return {release:(destroy?:boolean)=>client.release(destroy),query:async<T=any>(sql:string,values?:any[]):Promise<QueryResult<T>>=>{
   if(/^SELECT/i.test(sql)){const mode=(await query<{mode:string}>("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;seen.push({sql,mode});}
   expect(sql).not.toMatch(/SAVEPOINT|FOR (?:UPDATE|SHARE|KEY SHARE)/i);
   return query<T>(sql,values);
  }};
 });
 const view=await readInvoiceRevision(invoiceId,session);expect(view.invoice.id).toBe(invoiceId);expect(view.remainingMinor).toBe(1000);
 const outside=seen.filter(x=>x.mode!=="on");expect(outside.map(x=>x.sql)).toEqual(["SELECT pg_advisory_lock_shared(hashtextextended($1,0))","SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked"]);
 expect(seen.filter(x=>!outside.includes(x)).length).toBeGreaterThan(10);
});
it("named snapshot lookup rejects ordinary write transactions",async()=>{
 const client=await db.getPool().connect();try{await client.query("BEGIN");await expect(revalidateLegacySessionReadOnlySnapshot(session,client)).rejects.toThrow("READ_ONLY_SNAPSHOT_REQUIRED");}finally{await client.query("ROLLBACK");client.release();}
});
it("raw canonical account is refused without financial preview",async()=>{
 await db.getPool().query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({schemaVersion:1,revision:1,patientScope:"none",appointmentScope:"none",grants:{}}),session.userId]);
 try{await expect(readInvoiceRevision(invoiceId,session)).rejects.toThrow("PERMISSION_ENVELOPE_HELD");}finally{await db.getPool().query("UPDATE users SET permissions=NULL WHERE id=$1",[session.userId]);}
});
it("snapshot begins after observed installer contention and refuses its committed marker",async()=>{
 const holder=await db.getPool().connect();await holder.query("BEGIN");const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[fence]);
 const pending=readInvoiceRevision(invoiceId,session).then(()=>null,e=>e);let waiter=0;
 try{
  const deadline=performance.now()+5000;while(performance.now()<deadline){const rows=(await fixture.pool.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[pid])).rows;if(rows.length){waiter=rows[0].pid;break;}await new Promise(r=>setTimeout(r,10));}
  expect(waiter).toBeGreaterThan(0);await holder.query("CREATE TABLE staff_authority_control(synthetic INTEGER)");await holder.query("COMMIT");
  expect(await pending).toMatchObject({message:"LEGACY_STAFF_AUTHORITY_SCHEMA_HELD"});
  expect((await fixture.pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[waiter])).rows).toEqual([]);
 }finally{await holder.query("ROLLBACK");holder.release();await pending;await fixture.pool.query("DROP TABLE IF EXISTS staff_authority_control");}
});
