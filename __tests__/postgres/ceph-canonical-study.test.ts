/** Slice 34: saved studies, exact ownership, bounded snapshot and no clinical recomputation. */
import {afterAll,beforeAll,expect,it,vi} from "vitest";
import {Pool} from "pg";
import {assertRealPostgresUrl,stubPostgresEnv} from "./_setup";
import {openCanonicalInventoryDatabase,type CanonicalInventoryDatabase} from "./_canonical-inventory-fixture";
import {capabilityDocument,waitForBlockedBy} from "./_canonical-ready-fixture";
import {seedCanonicalCeph} from "../fixtures/canonical-ceph";
import type {CanonicalSnapshotQuery} from "../../lib/canonical-read-snapshot";
vi.mock("server-only",()=>({}));assertRealPostgresUrl();stubPostgresEnv();vi.stubEnv("SESSION_SECRET","synthetic-ceph-study-secret-0123456789abcdef");
const db=await import("../../lib/db"),reads=await import("../../lib/canonical-ceph-reads"),snapshots=await import("../../lib/canonical-read-snapshot");
const {CANONICAL_RECORD_READS}=await import("../../lib/canonical-record-reads");
const VIEW={"clinical.xrays.view":true};
const ACCOUNTS={
 owner:{username:"SYN-CD-OWNER",role:"admin"},
 own:{username:"SYN-CD-OWN",role:"doctor",doctor:true,patientScope:"own",grants:VIEW},
 all:{username:"SYN-CD-ALL",role:"reception",patientScope:"all",grants:VIEW},
 adjacent:{username:"SYN-CD-ORTHO",role:"admin",patientScope:"all",grants:{"clinical.ortho.view":true}},
 none:{username:"SYN-CD-NONE",role:"doctor",doctor:true,patientScope:"none",grants:VIEW},
 unlinked:{username:"SYN-CD-UNLINKED",role:"doctor",patientScope:"own",grants:VIEW},
} as const;
type Key=keyof typeof ACCOUNTS;let fx:CanonicalInventoryDatabase<Key>,side:Pool;
const ids={own:0,outside:0,completed:0,draft:0,document:0,foreign:0,discarded:0};
const read=async(key:Key,id=ids.completed)=>reads.readCanonicalCephStudy(await fx.session(key),id);
async function fullStudy(patientId=ids.own,status:"completed"|"draft"="completed") {
 const saved=await seedCanonicalCeph(fx.pool,{patientId,status});
 await fx.pool.query("UPDATE ceph_analyses SET cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=10,mm_per_pixel=0.1,ref_set='SYN historical reference' WHERE id=$1",[saved.id]);
 await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'S',100.125,50.25,'manual','SYN recorder'),($1,'SYN_OLD_CODE',2,3,'manual','SYN old recorder')",[saved.id]);
 await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SYN_OLD_MEASURE',123.123456)",[saved.id]);
 await fx.pool.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,dental,soft_tissue,note,final_dx,created_by) VALUES($1,'SYN skeletal','SYN dental','SYN tissue','SYN diagnosis note','SYN saved diagnosis','SYN recorder')",[saved.id]);
 return saved;
}
beforeAll(async()=>{
 fx=await openCanonicalInventoryDatabase(db,ACCOUNTS,"owner");side=new Pool({connectionString:fx.pool.options.connectionString,max:3});
 for(const key of ["own","outside"] as const)ids[key]=(await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id",[`SYN-CD-${key}`,key==="own"?fx.parties.own!:null])).rows[0].id;
 const saved=await fullStudy();ids.completed=saved.id;ids.document=saved.documentId;
 ids.draft=(await fullStudy(ids.own,"draft")).id;ids.foreign=(await fullStudy(ids.outside)).id;ids.discarded=(await seedCanonicalCeph(fx.pool,{patientId:ids.own,status:"discarded"})).id;
},180_000);
afterAll(async()=>{await side?.end();await fx?.close();});
it("registers the independent imaging capability and patient scope",()=>expect(CANONICAL_RECORD_READS["read:ceph.study"]).toEqual({record:"patient",need:["clinical.xrays.view"],anyOf:[]}));
it.each(["owner","own","all"] as const)("%s reads exact saved clinical values without a replacement engine or image access",async key=>{
 const result=await read(key);expect(Object.keys(result).sort()).toEqual(["analysis","diagnosis","landmarks","measurements","measurementsState","projection"]);
 expect(Object.keys(result.analysis).sort()).toEqual(["calibration","completedAt","completedBy","createdAt","createdBy","device","findings","id","imageState","mmPerPixel","note","patientId","phase","refSet","status","xrayDate"]);
 expect(result.analysis).toMatchObject({id:ids.completed,xrayDate:"2024-02-29",note:"SYN saved clinical note",refSet:"SYN historical reference",calibration:{x1:0,y1:0,x2:100,y2:0,mm:10},mmPerPixel:0.1});
 expect(result.measurements).toContainEqual({code:"SYN_OLD_MEASURE",value:123.123456});expect(result.landmarks).toContainEqual({code:"SYN_OLD_CODE",x:2,y:3,source:"manual",confirmedBy:"SYN old recorder"});
 expect(result.diagnosis?.finalDx).toBe("SYN saved diagnosis");expect(JSON.stringify(result)).not.toMatch(/storage|private image|private.png|documentId|orthoCaseId|invoice|price|phone/);
});
it.each(["none","unlinked","adjacent"] as const)("denies %s without role expansion",async key=>{await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);});
it("foreign, discarded and absent studies share one 404 without disclosure",async()=>{
 const errors=[];for(const id of [ids.foreign,ids.discarded,2147483647])try{await read("own",id);throw Error("unexpected");}catch(e){errors.push({code:(e as {code:string}).code,message:(e as Error).message});}
 expect(errors[0]).toEqual(errors[1]);expect(errors[1]).toEqual(errors[2]);expect(errors[0].code).toBe("patient_not_found");
});
it.each(["patientId=1","image=1","full=1","includeDiscarded=1","referenceSet=changed"])("rejects query expansion %s",query=>expect(()=>reads.canonicalCephReadId("1",new URLSearchParams(query))).toThrow());
it.each(["0","01","1e3","-1","9007199254740992"])("rejects unsafe/noncanonical study ID %s",id=>expect(()=>reads.canonicalCephReadId(id,new URLSearchParams())).toThrow());
it("preserves draft data but labels it explicitly unapproved and emits no approved summary findings",async()=>{
 const result=await read("own",ids.draft);expect(result).toMatchObject({measurementsState:"saved-unapproved",analysis:{status:"draft",findings:null}});expect(result.measurements).toContainEqual({code:"SYN_OLD_MEASURE",value:123.123456});
});
it("a missing diagnosis or calibration is honest absence, never generated replacement content",async()=>{
 const saved=await seedCanonicalCeph(fx.pool,{patientId:ids.own});const result=await read("own",saved.id);
 expect(result).toMatchObject({analysis:{calibration:null,mmPerPixel:null},landmarks:[],diagnosis:null});
});
it("an owned hidden image preserves saved data without image content or identity",async()=>{
 await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1",[ids.document]);
 try{const result=await read("own");expect(result.analysis.imageState).toBe("unavailable");expect(result.diagnosis?.finalDx).toBe("SYN saved diagnosis");expect(JSON.stringify(result)).not.toContain("private.png");}
 finally{await fx.pool.query("UPDATE patient_documents SET removed_at=NULL WHERE id=$1",[ids.document]);}
});
it("foreign document and optional ortho-case ownership reject the whole study, including notes and diagnosis",async()=>{
 const foreign=await seedCanonicalCeph(fx.pool,{patientId:ids.outside}),bad=await seedCanonicalCeph(fx.pool,{patientId:ids.own,documentId:foreign.documentId});
 await expect(read("owner",bad.id)).rejects.toMatchObject({code:"ceph_reference_unavailable"});
 const caseId=(await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[ids.outside])).rows[0].id;
 await fx.pool.query("UPDATE ceph_analyses SET document_id=$1,ortho_case_id=$2 WHERE id=$3",[ids.document,caseId,bad.id]);await expect(read("owner",bad.id)).rejects.toMatchObject({code:"ceph_reference_unavailable"});
});
it.each(["measurements","landmarks"] as const)("bounds all %s before materialization without silent truncation",async table=>{
 const saved=await seedCanonicalCeph(fx.pool,{patientId:ids.own});
 if(table==="measurements")await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) SELECT $1,'SYN'||n,1 FROM generate_series(1,257) n",[saved.id]);
 else await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,confirmed_by) SELECT $1,'SYN'||n,1,1,'SYN' FROM generate_series(1,257) n",[saved.id]);
 await expect(read("owner",saved.id)).rejects.toMatchObject({code:"ceph_read_limit"});
});
it("bounds stored bytes before materializing large notes and leaves the source unchanged",async()=>{
 const saved=await seedCanonicalCeph(fx.pool,{patientId:ids.own});await fx.pool.query("UPDATE ceph_analyses SET note=repeat('x',2100000) WHERE id=$1",[saved.id]);
 await expect(read("owner",saved.id)).rejects.toMatchObject({code:"ceph_read_limit"});expect((await fx.pool.query("SELECT length(note) n FROM ceph_analyses WHERE id=$1",[saved.id])).rows[0].n).toBe(2100000);
});
it.each(["partial-calibration","nonfinite-calibration","nonfinite-landmark","nonfinite-measure"])("fails safely on %s without rewriting historical facts",async kind=>{
 const saved=await seedCanonicalCeph(fx.pool,{patientId:ids.own});
 if(kind==="partial-calibration")await fx.pool.query("UPDATE ceph_analyses SET cal_x1=1 WHERE id=$1",[saved.id]);
 if(kind==="nonfinite-calibration")await fx.pool.query("UPDATE ceph_analyses SET mm_per_pixel='NaN' WHERE id=$1",[saved.id]);
 if(kind==="nonfinite-landmark")await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,confirmed_by) VALUES($1,'S','NaN',1,'SYN')",[saved.id]);
 if(kind==="nonfinite-measure")await fx.pool.query("UPDATE ceph_measurements SET value='Infinity' WHERE analysis_id=$1 AND code='ANB'",[saved.id]);
 await expect(read("owner",saved.id)).rejects.toMatchObject({code:"ceph_stored_data_invalid"});
});
function interceptQuery(wrap:(q:CanonicalSnapshotQuery)=>CanonicalSnapshotQuery) {
 const original=snapshots.runCanonicalReadSnapshot;
 return vi.spyOn(snapshots,"runCanonicalReadSnapshot").mockImplementationOnce((session,key,reader,options)=>original(session,key,(q,scope)=>reader(wrap(q),scope),options));
}
it("one RR READ ONLY lease covers every domain read with no pool/schema access or stored changes",async()=>{
 const sql="SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices,(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m WHERE analysis_id=$1) measurements,(SELECT to_jsonb(d) FROM ceph_diagnoses d WHERE analysis_id=$1) diagnosis";
 const before=(await fx.pool.query(sql,[ids.completed])).rows,session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema");
 const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");return q.query(text,args);}) as typeof q.query}));
 try{await reads.readCanonicalCephStudy(session,ids.completed);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();}
 finally{hook.mockRestore();connect.mockRestore();query.mockRestore();ensure.mockRestore();}
 expect((await fx.pool.query(sql,[ids.completed])).rows).toEqual(before);
});
it("scope, document ownership, landmarks and diagnosis cannot mix two concurrent states",async()=>{
 let changed=false;const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{const result=await q.query(text,args);if(!changed&&text.includes("a.device,a.ref_set")){changed=true;const w=await side.connect();try{await w.query("BEGIN");await w.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[ids.own]);await w.query("UPDATE ceph_landmarks SET x=999 WHERE analysis_id=$1 AND code='S'",[ids.completed]);await w.query("UPDATE ceph_diagnoses SET final_dx='SYN changed diagnosis' WHERE analysis_id=$1",[ids.completed]);await w.query("COMMIT");}finally{await w.query("ROLLBACK");w.release();}}return result;}) as typeof q.query}));
 try{const result=await read("own");expect(result.landmarks.find(p=>p.code==="S")?.x).toBe(100.125);expect(result.diagnosis?.finalDx).toBe("SYN saved diagnosis");hook.mockRestore();await expect(read("own")).rejects.toMatchObject({code:"patient_not_found"});expect((await read("all")).diagnosis?.finalDx).toBe("SYN changed diagnosis");}
 finally{hook.mockRestore();await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2",[fx.parties.own,ids.own]);await side.query("UPDATE ceph_landmarks SET x=100.125 WHERE analysis_id=$1 AND code='S'",[ids.completed]);await side.query("UPDATE ceph_diagnoses SET final_dx='SYN saved diagnosis' WHERE analysis_id=$1",[ids.completed]);}
});
it("expires during an actual lifecycle-fence wait",async()=>{
 const session=await fx.session("own",1500),holder=await side.connect();try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);const pending=reads.readCanonicalCephStudy(session,ids.completed);pending.catch(()=>undefined);
 try{expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await new Promise(r=>setTimeout(r,1700));}finally{await holder.query("COMMIT");}await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
 }finally{await holder.query("ROLLBACK");holder.release();}
});
it("rechecks a removed capability after the fence and denies fresh sessions too",async()=>{
 const stale=await fx.session("all"),holder=await side.connect();try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{},patientScope:"all"},2)),fx.ids.all]);
 const pending=reads.readCanonicalCephStudy(stale,ids.completed);pending.catch(()=>undefined);try{expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);}finally{await holder.query("COMMIT");}
 await expect(pending).rejects.toThrow(/STALE/);await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
 }finally{await holder.query("ROLLBACK");holder.release();await fx.setGrants("all",VIEW,{patientScope:"all"});}
});
it("scope revocation and retired credentials invalidate old authority without legacy fallback",async()=>{
 const stale=await fx.session("own");await fx.setGrants("own",VIEW,{patientScope:"none"});try{await expect(reads.readCanonicalCephStudy(stale,ids.completed)).rejects.toThrow(/STALE/);await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/);}finally{await fx.setGrants("own",VIEW,{patientScope:"own"});}
 const old=await fx.session("own");await fx.pool.query("UPDATE users SET password_hash='SYN retired study hash' WHERE id=$1",[fx.ids.own]);await expect(reads.readCanonicalCephStudy(old,ids.completed)).rejects.toThrow(/STALE/);expect((await read("own")).analysis.id).toBe(ids.completed);
});
it("an intermediate query failure rejects the entire result and leaves the next lease usable",async()=>{
 const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>text.startsWith("SELECT code,value")?q.query("SELECT 1/0"):q.query(text,args)) as typeof q.query}));
 try{await expect(read("own")).rejects.toThrow();}finally{hook.mockRestore();}expect((await read("own")).diagnosis?.finalDx).toBe("SYN saved diagnosis");
});
it("a concurrently moved backing document stays in the admitted snapshot and is refused on the next read",async()=>{
 let changed=false;const hook=interceptQuery(q=>({query:(async(text:string,args?:unknown[])=>{
   const result=await q.query(text,args);
   if(!changed&&text.includes("a.device,a.ref_set")){changed=true;await side.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[ids.outside,ids.document]);}
   return result;
 }) as typeof q.query}));
 try{expect((await read("own")).diagnosis?.finalDx).toBe("SYN saved diagnosis");hook.mockRestore();await expect(read("owner")).rejects.toMatchObject({code:"ceph_reference_unavailable"});}
 finally{hook.mockRestore();await side.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[ids.own,ids.document]);}
});
