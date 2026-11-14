/** Slice 33: PostgreSQL snapshot/scope and saved cephalometric summaries. */
import {afterAll,beforeAll,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {assertRealPostgresUrl,stubPostgresEnv} from "./_setup";
import {openCanonicalInventoryDatabase,type CanonicalInventoryDatabase} from "./_canonical-inventory-fixture";
import {capabilityDocument,waitForBlockedBy} from "./_canonical-ready-fixture";
import {seedCanonicalCeph} from "../fixtures/canonical-ceph";
import type {CanonicalSnapshotQuery} from "../../lib/canonical-read-snapshot";
vi.mock("server-only",()=>({}));assertRealPostgresUrl();stubPostgresEnv();vi.stubEnv("SESSION_SECRET","synthetic-ceph-list-secret-0123456789abcdef");
const db=await import("../../lib/db"),reads=await import("../../lib/canonical-ceph-reads"),patientReads=await import("../../lib/canonical-patient-reads");
const {CANONICAL_RECORD_READS}=await import("../../lib/canonical-record-reads");
const VIEW={"clinical.xrays.view":true};
const ACCOUNTS={
 owner:{username:"SYN-CL-OWNER",role:"admin"},
 own:{username:"SYN-CL-OWN",role:"doctor",doctor:true,patientScope:"own",grants:VIEW},
 all:{username:"SYN-CL-ALL",role:"reception",patientScope:"all",grants:VIEW},
 adjacent:{username:"SYN-CL-ORTHO",role:"admin",patientScope:"all",grants:{"clinical.ortho.view":true}},
 none:{username:"SYN-CL-NONE",role:"doctor",doctor:true,patientScope:"none",grants:VIEW},
 unlinked:{username:"SYN-CL-UNLINKED",role:"doctor",patientScope:"own",grants:VIEW},
} as const;
type Key=keyof typeof ACCOUNTS;let fx:CanonicalInventoryDatabase<Key>,side:Pool;
const ids={own:0,outside:0,empty:0,completed:0,draft:0,document:0};
const read=async(key:Key,patientId=ids.own)=>reads.readCanonicalCephList(await fx.session(key),patientId);
const patient=async(label:string)=> (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id",[`SYN-CL-${label}`,fx.parties.own!])).rows[0].id as number;
beforeAll(async()=>{
 fx=await openCanonicalInventoryDatabase(db,ACCOUNTS,"owner");side=new Pool({connectionString:fx.pool.options.connectionString,max:3});
 for(const key of ["own","outside","empty"] as const)ids[key]=await patient(key);
 await fx.pool.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[ids.outside]);
 const saved=await seedCanonicalCeph(fx.pool,{patientId:ids.own});ids.completed=saved.id;ids.document=saved.documentId;
 ids.draft=(await seedCanonicalCeph(fx.pool,{patientId:ids.own,status:"draft"})).id;
 await seedCanonicalCeph(fx.pool,{patientId:ids.own,status:"discarded"});await seedCanonicalCeph(fx.pool,{patientId:ids.outside});
},180_000);
afterAll(async()=>{await side?.end();await fx?.close();});
it("registers independent imaging capability and patient scope",()=>expect(CANONICAL_RECORD_READS["read:ceph.list"]).toEqual({record:"patient",need:["clinical.xrays.view"],anyOf:[]}));
it.each(["owner","own","all"] as const)("%s reads saved values and explicit draft state with an allowlist",async key=>{
 const result=await read(key);expect(Object.keys(result).sort()).toEqual(["analyses","clinicTimeZone","hasMore","patientId","projection"]);
 expect(result.analyses.map(a=>a.id)).toEqual([ids.draft,ids.completed]);expect(result.analyses[0].findings).toBeNull();
 const a=result.analyses[1];expect(Object.keys(a).sort()).toEqual(["completedAt","createdAt","findings","id","imageState","patientId","phase","status","xrayDate"]);
 expect(a).toMatchObject({xrayDate:"2024-02-29",findings:{anb:3.125,fma:26.75,wits:-1.125}});
 expect(JSON.stringify(result)).not.toMatch(/documentId|storage|private|note|device|createdBy|orthoCase|diagnosis|invoice|calibration|phone/);
});
it.each(["none","unlinked","adjacent"] as const)("denies %s without role expansion",async key=>{await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);} );
it("outside and missing are indistinguishable; a legitimate empty file is explicit",async()=>{
 const errors=[];for(const id of [ids.outside,2147483647])try{await read("own",id);throw Error("unexpected");}catch(e){errors.push({code:(e as {code:string}).code,message:(e as Error).message});}
 expect(errors[0]).toEqual(errors[1]);expect(errors[0].code).toBe("patient_not_found");expect(await read("own",ids.empty)).toMatchObject({analyses:[],hasMore:false});
});
it.each(["patientId=1","includeImages=1","status=discarded","limit=301","doctorId=1"])("rejects query expansion %s",query=>expect(()=>reads.canonicalCephReadId("1",new URLSearchParams(query),true)).toThrow());
it.each(["0","01","1e3","-1","2147483648"])("rejects noncanonical patient identity %s",id=>expect(()=>reads.canonicalCephReadId(id,new URLSearchParams(),true)).toThrow());
it("retains owned historical values when an image is hidden, without publishing its identity or content",async()=>{
 await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1",[ids.document]);
 try{const result=await read("own");expect(result.analyses.find(a=>a.id===ids.completed)).toMatchObject({imageState:"unavailable",findings:{anb:3.125}});expect(JSON.stringify(result)).not.toContain("private");}
 finally{await fx.pool.query("UPDATE patient_documents SET removed_at=NULL WHERE id=$1",[ids.document]);}
});
it("refuses foreign backing documents and foreign orthodontic relations without an existence leak in error details",async()=>{
 const p=await patient("foreign-ref"),foreign=await seedCanonicalCeph(fx.pool,{patientId:ids.outside});
 const bad=await seedCanonicalCeph(fx.pool,{patientId:p,documentId:foreign.documentId});
 await expect(read("owner",p)).rejects.toMatchObject({code:"ceph_reference_unavailable"});
 await fx.pool.query("UPDATE ceph_analyses SET document_id=$1 WHERE id=$2",[ids.document,bad.id]);
 const ownDoc=(await seedCanonicalCeph(fx.pool,{patientId:p})).documentId;
 const foreignCase=(await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[ids.outside])).rows[0].id;
 await fx.pool.query("UPDATE ceph_analyses SET document_id=$1,ortho_case_id=$2 WHERE id=$3",[ownDoc,foreignCase,bad.id]);
 await expect(read("owner",p)).rejects.toMatchObject({code:"ceph_reference_unavailable"});
});
it("bounds the list at 300 in deterministic draft-first order with honest hasMore",async()=>{
 const p=await patient("bound"),base=await seedCanonicalCeph(fx.pool,{patientId:p});
 await fx.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,created_at) SELECT $1,$2,'completed','SYN','2020-01-01'::timestamptz FROM generate_series(1,300)",[p,base.documentId]);
 const draft=await seedCanonicalCeph(fx.pool,{patientId:p,status:"draft"});
 const result=await read("own",p);expect(result.analyses).toHaveLength(300);expect(result.hasMore).toBe(true);expect(result.analyses[0].id).toBe(draft.id);
 const ids=result.analyses.slice(2).map(a=>a.id);expect(ids).toEqual([...ids].sort((a,b)=>b-a));
});
it("non-finite stored values fail rather than silently becoming null JSON or being recalculated",async()=>{
 const p=await patient("nan");await seedCanonicalCeph(fx.pool,{patientId:p,value:NaN});
 await expect(read("own",p)).rejects.toMatchObject({code:"ceph_stored_data_invalid"});
});
function interceptQuery(wrap:(q:CanonicalSnapshotQuery)=>CanonicalSnapshotQuery) {
 const original=patientReads.readCanonicalPatientRecord;
 return vi.spyOn(patientReads,"readCanonicalPatientRecord").mockImplementationOnce((session,key,id,reader,maxBytes)=>original(session,key,id,(q,scope)=>reader(wrap(q),scope),maxBytes));
}
it("uses one read-only RR lease and no pool query, schema initialization, audit or financial mutation",async()=>{
 const session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema");
 const before=(await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices")).rows;
 const proof=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");return q.query(text,args);}) as typeof q.query}));
 try{await reads.readCanonicalCephList(session,ids.own);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();}
 finally{proof.mockRestore();connect.mockRestore();query.mockRestore();ensure.mockRestore();}
 expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices")).rows).toEqual(before);
});
it("scope, study metadata and saved values share a snapshot across a concurrent update",async()=>{
 let changed=false;
 const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{const result=await q.query(text,args);if(!changed&&text.includes("FROM ceph_analyses a")){changed=true;const w=await side.connect();try{await w.query("BEGIN");await w.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[ids.own]);await w.query("UPDATE ceph_measurements SET value=99 WHERE analysis_id=$1 AND code='ANB'",[ids.completed]);await w.query("COMMIT");}finally{await w.query("ROLLBACK");w.release();}}return result;}) as typeof q.query}));
 try{expect((await read("own")).analyses[1].findings?.anb).toBe(3.125);hook.mockRestore();await expect(read("own")).rejects.toMatchObject({code:"patient_not_found"});expect((await read("all")).analyses[1].findings?.anb).toBe(99);}
 finally{hook.mockRestore();await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2",[fx.parties.own,ids.own]);await side.query("UPDATE ceph_measurements SET value=3.125 WHERE analysis_id=$1 AND code='ANB'",[ids.completed]);}
});
it("expires authority during a real lifecycle-fence wait",async()=>{
 const session=await fx.session("own",1500),holder=await side.connect();try{
 await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
 const pending=reads.readCanonicalCephList(session,ids.own);pending.catch(()=>undefined);try{expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await new Promise(r=>setTimeout(r,1700));}finally{await holder.query("COMMIT");}await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
 }finally{await holder.query("ROLLBACK");holder.release();}
});
it("rechecks revoked capability after waiting, then rejects fresh sessions without imaging grant",async()=>{
 const stale=await fx.session("all"),holder=await side.connect();try{
 await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
 await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{},patientScope:"all"},2)),fx.ids.all]);
 const pending=reads.readCanonicalCephList(stale,ids.own);pending.catch(()=>undefined);try{expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);}finally{await holder.query("COMMIT");}
 await expect(pending).rejects.toThrow(/STALE/);await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
 }finally{await holder.query("ROLLBACK");holder.release();await fx.setGrants("all",VIEW,{patientScope:"all"});}
});
it("patient scope revocation and credential retirement do not reuse an old admitted session",async()=>{
 const stale=await fx.session("own");await fx.setGrants("own",VIEW,{patientScope:"none"});
 try{await expect(reads.readCanonicalCephList(stale,ids.own)).rejects.toThrow(/STALE/);await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/);}finally{await fx.setGrants("own",VIEW,{patientScope:"own"});}
 const old=await fx.session("own");await fx.pool.query("UPDATE users SET password_hash='SYN retired ceph hash' WHERE id=$1",[fx.ids.own]);await expect(reads.readCanonicalCephList(old,ids.own)).rejects.toThrow(/STALE/);expect((await read("own")).analyses).toHaveLength(2);
});
it("a failed saved-value read rejects the entire response and releases the lease",async()=>{
 const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>text.includes("FROM ceph_measurements")?q.query("SELECT 1/0"):q.query(text,args)) as typeof q.query}));
 try{await expect(read("own")).rejects.toThrow();}finally{hook.mockRestore();}expect((await read("own")).analyses).toHaveLength(2);
});
it("normalizes real-server BIGINT strings before matching saved measurements and publishing typed IDs",async()=>{
 const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{
   const result=await q.query(text,args);
   if(text.includes("FROM ceph_analyses a"))return {...result,rows:result.rows.map(row=>({...row,id:String(row.id)}))};
   if(text.includes("FROM ceph_measurements"))return {...result,rows:result.rows.map(row=>({...row,analysis_id:String(row.analysis_id)}))};
   return result;
 }) as typeof q.query}));
 try{const result=await read("own");expect(result.analyses.map(a=>a.id)).toEqual([ids.draft,ids.completed]);expect(result.analyses[1].findings?.anb).toBe(3.125);}finally{hook.mockRestore();}
});
it("a draft never presents stored measurement rows as an approved snapshot",async()=>{
 await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'ANB',88)",[ids.draft]);
 expect((await read("own")).analyses[0]).toMatchObject({status:"draft",findings:null});
});
it("unsafe BIGINT identities reject instead of rounding two records onto one browser identity",async()=>{
 const p=await patient("unsafe-id"),base=await seedCanonicalCeph(fx.pool,{patientId:p});
 await fx.pool.query("INSERT INTO ceph_analyses(id,patient_id,document_id,status,created_by) VALUES(9007199254740992,$1,$2,'completed','SYN')",[p,base.documentId]);
 await expect(read("own",p)).rejects.toMatchObject({code:"ceph_stored_data_invalid"});
});
