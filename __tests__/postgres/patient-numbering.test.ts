import {afterAll,beforeAll,expect,it} from "vitest";
import {createHash} from "node:crypto";
import type {SessionPayload} from "../../lib/auth";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const numbers=await import("../../lib/patient-numbering-db");
const {parseCsv}=await import("../../lib/patient-import");
const {patientNumberingReadiness}=await import("../../lib/patient-numbering-readiness");
const q=(sql:string,params:unknown[]=[])=>db.getPool().query(sql,params);
let session:SessionPayload, serial=0;
const patient=()=>db.createPatient({fullName:`Synthetic numbering ${++serial}`,phone:null,altPhone:null,gender:"unknown",birthYear:null,address:null,medicalAlert:null,note:null});
const edit=(id:number,current:{patientNumber:string;version:string},number:string)=>numbers.changePatientNumber(session,id,{patientNumber:number,expectedVersion:current.version,expectedPatientNumber:current.patientNumber,reason:"Synthetic paper file correction"});
beforeAll(async()=>{
 await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
 const hash=await auth.hashPassword("synthetic-numbering-password");
 const user=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('numbering-admin','Synthetic numbering',$1,'admin',true) RETURNING id",[hash])).rows[0];
 session={userId:user.id,username:"numbering-admin",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
});
afterAll(async()=>{await db.resetPoolForTesting();});
it("registered startup preserves an empty numbering policy and read-only readiness",async()=>{
 expect(await patientNumberingReadiness(db.getPool())).toEqual({ready:true,ambiguousAliasGroups:0});
 const {loadMigrationFiles}=await import("../../lib/migration-files");
 const file=(await loadMigrationFiles()).find(file=>file.version==="0080")!;
 expect((await q("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0080'")).rows).toEqual([{name:file.name,checksum:file.checksum,adopted:false}]);
 await db.resetPoolForTesting();await db.ensureSchema();
 expect((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE version='0080'")).rows[0].n).toBe(1);
 expect((await q("SELECT * FROM patient_numbering_policy")).rows).toEqual([]);
});
it("preview is read-only and the first newly generated file starts at P-07000",async()=>{
 const before=await q("SELECT last_value::text,is_called FROM patient_number_seq");
 expect(await numbers.readNumberingPreview(session)).toMatchObject({minimumNext:"7000",version:"1",nextNumber:"P-07000",maximumCurrent:"0",maximumRetired:"0"});
 expect((await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows).toEqual(before.rows);
 expect((await q("SELECT * FROM patient_numbering_policy")).rows).toEqual([]);
 expect((await patient()).patientNumber).toBe("P-07000");
});
it("refuses reset of current file identities before backup and preserves rows and sequence",async()=>{
 expect((await q("SELECT count(*)::int AS n FROM retired_patient_numbers")).rows[0].n).toBe(0);
 const before=(await q("SELECT to_jsonb(p) AS row FROM patients p ORDER BY id")).rows;
 expect(before.length).toBeGreaterThan(0);
 const sequence=(await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows;
 let backupCalled=false;
 await expect(db.resetClinicData({actor:session.username,actorRole:session.role},async()=>{backupCalled=true;return {ok:true,backupId:"synthetic"};})).rejects.toMatchObject({name:"ProtectedPatientNumberHistoryError"});
 expect(backupCalled).toBe(false);
 expect((await q("SELECT to_jsonb(p) AS row FROM patients p ORDER BY id")).rows).toEqual(before);
 expect((await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows).toEqual(sequence);
});
it("guards raw current-identity truncation and concurrent historical ownership insertion",async()=>{
 const before=(await q("SELECT id,patient_number FROM patients ORDER BY id")).rows;
 await expect(q("TRUNCATE patients CASCADE")).rejects.toThrow("current patient identifiers cannot be truncated");
 expect((await q("SELECT id,patient_number FROM patients ORDER BY id")).rows).toEqual(before);
 const client=await db.getPool().connect();
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_numbering'))");
  await expect(q("INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES('SYN-CONCURRENT-ALIAS',999999)")).rejects.toMatchObject({code:"55P03"});
  await client.query("ROLLBACK");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await expect(client.query("INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES('SYN-SNAPSHOT-ALIAS',999999)")).rejects.toMatchObject({code:"25000"});
 }finally{await client.query("ROLLBACK");client.release();}
 expect((await q("SELECT count(*)::int AS n FROM retired_patient_numbers")).rows[0].n).toBe(0);
});
it("retains internal identity, linked clinical/financial rows and a complete old/new audit",async()=>{
 const p=(await q("INSERT INTO patients(patient_number,full_name,phone) VALUES('P-00042','Synthetic historical','967777000111') RETURNING id")).rows[0];
 await q("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic historical')",[p.id]);
 await q("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES('SYN-NUMBER-INV',$1,100)",[p.id]);
 const before=(await q("SELECT (SELECT jsonb_agg(to_jsonb(v)) FROM visits v WHERE patient_id=$1) AS visits,(SELECT jsonb_agg(to_jsonb(i)) FROM invoices i WHERE patient_id=$1) AS invoices",[p.id])).rows;
 const snapshot=await numbers.readPatientNumber(session,p.id);
 const after=await edit(p.id,snapshot,"123");expect(after).toEqual({patientId:p.id,patientNumber:"P-00123",version:"2"});
 expect((await q("SELECT (SELECT jsonb_agg(to_jsonb(v)) FROM visits v WHERE patient_id=$1) AS visits,(SELECT jsonb_agg(to_jsonb(i)) FROM invoices i WHERE patient_id=$1) AS invoices",[p.id])).rows).toEqual(before);
 expect((await q("SELECT details FROM audit_log WHERE action='patient.number.change' AND entity_id=$1",[String(p.id)])).rows[0].details).toMatchObject({before:snapshot,after,reason:"Synthetic paper file correction",oldNumberRetired:true});
 expect(await db.portalLogin("777000111","P-00042")).toBeNull();
 expect(await db.portalLogin("777000111","P-00123")).toMatchObject({patient:{id:p.id,patientNumber:"P-00123"}});
 await expect(edit(p.id,snapshot,"124")).rejects.toMatchObject({code:"stale"});
 await expect(edit(p.id,after,"42")).rejects.toMatchObject({code:"duplicate"});
});
it("blocks current aliases, leading-zero aliases and permanently retired aliases",async()=>{
 const p=await patient(), current=await numbers.readPatientNumber(session,p.id);
 await expect(edit(p.id,current,"123")).rejects.toMatchObject({code:"duplicate"});
 await expect(q("INSERT INTO patients(patient_number,full_name) VALUES('P-123','Synthetic alias')")).rejects.toMatchObject({code:"23505"});
 await expect(q("INSERT INTO patients(patient_number,full_name) VALUES('P-00000042','Synthetic retired alias')")).rejects.toMatchObject({code:"23505"});
});
it("rolls back the number, version and reservation when audit insertion fails",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 await q("CREATE FUNCTION synthetic_numbering_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.number.change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_numbering_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_numbering_audit_failure()");
 try{await expect(edit(p.id,before,"456")).rejects.toThrow("synthetic audit failure");}
 finally{await q("DROP TRIGGER synthetic_numbering_audit_failure ON audit_log; DROP FUNCTION synthetic_numbering_audit_failure()");}
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
 expect((await q("SELECT * FROM retired_patient_numbers WHERE patient_number=$1",[before.patientNumber])).rows).toEqual([]);
});
it("serializes two manual edits with the same version: exactly one succeeds",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 const results=await Promise.allSettled([edit(p.id,before,"501"),edit(p.id,before,"502")]);
 expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
 expect(results.filter(x=>x.status==="rejected").map(x=>(x as PromiseRejectedResult).reason.code)).toEqual(["stale"]);
 expect((await numbers.readPatientNumber(session,p.id)).version).toBe("2");
});
it("concurrent import, create and manual edits cannot collide",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 const csv="الاسم,الهاتف\nمريض استيراد الترقيم,771554001\nمريض استيراد الترقيم الثاني,771554002\n";
 const results=await Promise.all([edit(p.id,before,"25000"),...Array.from({length:8},()=>patient()),db.commitPatientImport({rows:parseCsv(csv),fileSha256:createHash("sha256").update(csv).digest("hex"),fileName:"synthetic.csv",today:"2026-10-26",includePossibleDuplicates:false,actor:session.username,actorRole:session.role})]);
 expect(results.at(-1)).toMatchObject({ok:true});
 expect((await q("SELECT aqlan_patient_number_numeric(patient_number) FROM patients WHERE aqlan_patient_number_numeric(patient_number)>0 GROUP BY 1 HAVING count(*)>1")).rows).toEqual([]);
 const next=await numbers.readNumberingPreview(session);expect(BigInt(next.nextNumber!.slice(2))).toBeGreaterThan(25000n);
});
it("honors the shared import lock for the central allocator",async()=>{
 const client=await db.getPool().connect();let task:ReturnType<typeof patient>|undefined;
 try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_import'))");let done=false;
 task=patient().then(p=>{done=true;return p;});await new Promise(resolve=>setTimeout(resolve,100));expect(done).toBe(false);
 await client.query("COMMIT");expect((await task).patientNumber).toMatch(/^P-/);
 }finally{await client.query("ROLLBACK");client.release();if(task)await task;}
});
it.each(["REPEATABLE READ","SERIALIZABLE"])("rejects stale %s alias writes even after the numbering lock becomes free",async(isolation)=>{
 const client=await db.getPool().connect();const alias=String(26000+ ++serial);
 try{await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);await client.query("SELECT count(*) FROM patients");
 await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic committed alias')",[`P-${alias}`]);
 await expect(client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic stale alias')",[`P-0${alias}`])).rejects.toMatchObject({code:"25000"});
 }finally{await client.query("ROLLBACK");client.release();}
});
it("rejects repeatable-read allocation itself",async()=>{
 const client=await db.getPool().connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");await expect(client.query("SELECT aqlan_allocate_patient_number()")).rejects.toMatchObject({code:"25000"});}finally{await client.query("ROLLBACK");client.release();}
});
it("requires current preview CAS and only advances the configurable future floor",async()=>{
 let before=await numbers.readNumberingPreview(session);
 await patient();
 await expect(numbers.changeNumberingFloor(session,{minimumNext:"30000",expectedVersion:before.version,expectedNextNumber:before.nextNumber,reason:"Synthetic floor"})).rejects.toMatchObject({code:"stale"});
 before=await numbers.readNumberingPreview(session);
 const after=await numbers.changeNumberingFloor(session,{minimumNext:"30000",expectedVersion:before.version,expectedNextNumber:before.nextNumber,reason:"Synthetic future floor"});
 expect(after).toMatchObject({minimumNext:"30000",version:"2",nextNumber:"P-30000"});
 expect((await patient()).patientNumber).toBe("P-30000");
 const next=await numbers.readNumberingPreview(session);
 await expect(numbers.changeNumberingFloor(session,{minimumNext:"7000",expectedVersion:next.version,expectedNextNumber:next.nextNumber,reason:"Synthetic rollback"})).rejects.toMatchObject({code:"invalid"});
 await expect(q("UPDATE patient_numbering_policy SET minimum_next=7000,version=version+1")).rejects.toThrow("monotonically");
});
it("refuses revoked/expired/nonadmin sessions before any numbering mutation",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 await expect(numbers.changePatientNumber({...session,expiresAt:0},p.id,{patientNumber:"999",expectedVersion:before.version,expectedPatientNumber:before.patientNumber,reason:"Synthetic expired"})).rejects.toMatchObject({code:"forbidden"});
 await q("UPDATE users SET is_active=false WHERE id=$1",[session.userId]);
 try{await expect(edit(p.id,before,"999")).rejects.toMatchObject({code:"forbidden"});}finally{await q("UPDATE users SET is_active=true WHERE id=$1",[session.userId]);}
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
});
it("rechecks session expiry after waiting for the exact patient row",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id), client=await db.getPool().connect();
 let work:Promise<unknown>|undefined;
 try{await client.query("BEGIN");await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[p.id]);
 const short={...session,expiresAt:Date.now()+150};
 work=numbers.changePatientNumber(short,p.id,{patientNumber:"998",expectedVersion:before.version,expectedPatientNumber:before.patientNumber,reason:"Synthetic expiring session"});
 const outcome=work.then(()=>({code:"unexpected-success"}),error=>error);
 await new Promise(resolve=>setTimeout(resolve,220));await client.query("COMMIT");expect(await outcome).toMatchObject({code:"forbidden"});
 }finally{await client.query("ROLLBACK");client.release();if(work)await work.catch(()=>{});}
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
});
it("rolls back policy creation/change when its audit fails",async()=>{
 const before=await numbers.readNumberingPreview(session);
 await q("CREATE FUNCTION synthetic_numbering_floor_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.numbering.configure' THEN RAISE EXCEPTION 'synthetic floor audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_numbering_floor_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_numbering_floor_audit_failure()");
 try{await expect(numbers.changeNumberingFloor(session,{minimumNext:"40000",expectedVersion:before.version,expectedNextNumber:before.nextNumber,reason:"Synthetic floor"})).rejects.toThrow("synthetic floor audit failure");}
 finally{await q("DROP TRIGGER synthetic_numbering_floor_audit_failure ON audit_log; DROP FUNCTION synthetic_numbering_floor_audit_failure()");}
 expect(await numbers.readNumberingPreview(session)).toEqual(before);
});
it("retains old identifiers after deletion and refuses resetting populated retirement history",async()=>{
 const p=await patient();await q("DELETE FROM patients WHERE id=$1",[p.id]);
 expect((await q("SELECT patient_id FROM retired_patient_numbers WHERE patient_number=$1",[p.patientNumber])).rows).toEqual([{patient_id:String(p.id)}]);
 await expect(q("DELETE FROM retired_patient_numbers")).rejects.toThrow("immutable");
 await expect(q("UPDATE retired_patient_numbers SET patient_id=1")).rejects.toThrow("immutable");
 await expect(q("TRUNCATE retired_patient_numbers")).rejects.toThrow("immutable");
 let backupCalled=false;
 await expect(db.resetClinicData({actor:session.username,actorRole:session.role},async()=>{backupCalled=true;return {ok:true,backupId:"synthetic"};})).rejects.toMatchObject({name:"ProtectedPatientNumberHistoryError"});
 expect(backupCalled).toBe(false);
});
it("records indexed maximum-query evidence on a bounded 1000-row synthetic fixture",async()=>{
 await q("INSERT INTO patients(patient_number,full_name) SELECT 'P-'||(50000+g)::text,'Synthetic numbering performance '||g::text FROM generate_series(1,1000) g");
 await q("ANALYZE patients");
 const plan=(await q("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT max(aqlan_patient_number_numeric(patient_number)) FROM patients")).rows[0]["QUERY PLAN"][0];
 console.log("NUMBERING_SYNTHETIC_MAX_QUERY",JSON.stringify({fixtureRows:1000,executionMs:plan["Execution Time"],plan:plan.Plan}));
 expect(JSON.stringify(plan.Plan)).toContain("patient_number_numeric_idx");
 expect((await numbers.readNumberingPreview(session)).nextNumber).toBe("P-51001");
});
it("uses indexed max projections and preserves full-width exhaustion without wraparound",async()=>{
 const indexes=(await q("SELECT indexname FROM pg_indexes WHERE tablename IN ('patients','retired_patient_numbers')")).rows.map(r=>r.indexname);
 expect(indexes).toEqual(expect.arrayContaining(["patient_number_numeric_idx","retired_patient_number_numeric_idx"]));
 await q("SELECT setval('patient_number_seq',9223372036854775807,true)");
 expect(await numbers.readNumberingPreview(session)).toMatchObject({exhausted:true,nextNumber:null});
 await expect(patient()).rejects.toMatchObject({code:"2200H"});
});
