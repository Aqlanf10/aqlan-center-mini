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
it("defers manual edits and preserves existing identity, portal access, history, audit and linked rows",async()=>{
 const p=(await q("INSERT INTO patients(patient_number,full_name,phone) VALUES('P-00042','Synthetic historical','967777000111') RETURNING id")).rows[0];
 await q("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic historical')",[p.id]);
 await q("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES('SYN-NUMBER-INV',$1,100)",[p.id]);
 const witnesses=async()=>({
  patient:(await q("SELECT to_jsonb(p) AS row FROM patients p WHERE id=$1",[p.id])).rows,
  visits:(await q("SELECT to_jsonb(v) AS row FROM visits v WHERE patient_id=$1 ORDER BY id",[p.id])).rows,
  invoices:(await q("SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id=$1 ORDER BY id",[p.id])).rows,
  history:(await q("SELECT * FROM retired_patient_numbers ORDER BY patient_number")).rows,
  audit:(await q("SELECT to_jsonb(a) AS row FROM audit_log a ORDER BY id")).rows,
  sequence:(await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows,
 });
 const before=await witnesses(), snapshot=await numbers.readPatientNumber(session,p.id);
 for(const target of ["123","880","42"]) await expect(edit(p.id,snapshot,target)).rejects.toMatchObject({code:"forbidden"});
 expect(await witnesses()).toEqual(before);
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(snapshot);
 expect(await db.portalLogin("777000111","P-00042")).toMatchObject({patient:{id:p.id,patientNumber:"P-00042"}});
 expect(await db.portalLogin("777000111","P-00123")).toBeNull();
});
it("characterizes immutable0080 raw SQL history guards without enabling an application edit workflow",async()=>{
 // This is a synthetic migration-contract witness, not an application/manual correction path.
 const p=(await q("INSERT INTO patients(patient_number,full_name) VALUES('P-00083','Synthetic legacy guard') RETURNING id")).rows[0];
 await q("UPDATE patients SET patient_number='P-00123' WHERE id=$1",[p.id]);
 expect((await q("SELECT patient_number,patient_number_version::text FROM patients WHERE id=$1",[p.id])).rows).toEqual([{patient_number:"P-00123",patient_number_version:"2"}]);
 expect((await q("SELECT patient_id::text FROM retired_patient_numbers WHERE patient_number='P-00083'")).rows).toEqual([{patient_id:String(p.id)}]);
 await expect(q("UPDATE patients SET patient_number='P-00083' WHERE id=$1",[p.id])).rejects.toMatchObject({code:"23505"});
 await expect(q("INSERT INTO patients(patient_number,full_name) VALUES('P-123','Synthetic current alias')")).rejects.toMatchObject({code:"23505"});
 await expect(q("INSERT INTO patients(patient_number,full_name) VALUES('P-00000083','Synthetic retired alias')")).rejects.toMatchObject({code:"23505"});
});
it("rejects edits before audit work even when the numbering audit writer would fail",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 const auditBefore=(await q("SELECT to_jsonb(a) AS row FROM audit_log a ORDER BY id")).rows;
 await q("CREATE FUNCTION synthetic_numbering_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.number.change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_numbering_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_numbering_audit_failure()");
 try{await expect(edit(p.id,before,"456")).rejects.toMatchObject({code:"forbidden"});}
 finally{await q("DROP TRIGGER synthetic_numbering_audit_failure ON audit_log; DROP FUNCTION synthetic_numbering_audit_failure()");}
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
 expect((await q("SELECT * FROM retired_patient_numbers WHERE patient_number=$1",[before.patientNumber])).rows).toEqual([]);
 expect((await q("SELECT to_jsonb(a) AS row FROM audit_log a ORDER BY id")).rows).toEqual(auditBefore);
});
it("refuses both concurrent manual edits without changing the version or reservation",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id);
 const results=await Promise.allSettled([edit(p.id,before,"501"),edit(p.id,before,"502")]);
 expect(results.every(result=>result.status==="rejected")).toBe(true);
 expect(results.map(result=>(result as PromiseRejectedResult).reason.code)).toEqual(["forbidden","forbidden"]);
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
 expect((await q("SELECT * FROM retired_patient_numbers WHERE patient_number=$1",[before.patientNumber])).rows).toEqual([]);
});
it("allocates uniquely above a pre-existing high number across concurrent direct, import, visit and booking creation",async()=>{
 // A populated predecessor may already exceed7000 even while its sequence is lower.
 const high=(await q("INSERT INTO patients(patient_number,full_name) VALUES('P-25000','Synthetic pre-existing high number') RETURNING id")).rows[0];
 const prior=(await q("SELECT id,patient_number,patient_number_version::text FROM patients ORDER BY id")).rows;
 const history=(await q("SELECT * FROM retired_patient_numbers ORDER BY patient_number")).rows;
 const visit=await db.addVisit({patientName:"Synthetic numbering walk-in",patientPhone:"771554003",note:null});
 const request=await db.createBookingRequest({fullName:"Synthetic numbering booking",phone:"967771554004",reason:null,preferredDate:"2030-01-02",preferredPeriod:"any"},null);
 const csv="الاسم,الهاتف\nعبدالله منصور الحضرمي,771554001\nسارة خالد الزبيدي,771554002\n";
 const [direct,imported,fromVisit,fromBooking]=await Promise.all([
  Promise.all(Array.from({length:8},()=>patient())),
  db.commitPatientImport({rows:parseCsv(csv),fileSha256:createHash("sha256").update(csv).digest("hex"),fileName:"synthetic.csv",today:"2026-10-26",includePossibleDuplicates:false,actor:session.username,actorRole:session.role}),
  db.createNextSession({visitId:visit.id,date:"2030-01-02",time:"09:00",durationMinutes:30,phone:null,note:null}),
  db.confirmBookingRequest({id:request.id,date:"2030-01-02",time:"10:00",durationMinutes:30}),
 ]);
 expect(imported).toMatchObject({ok:true});
 expect(fromVisit).not.toBeNull();expect(fromBooking).not.toBeNull();
 if(!fromVisit||!fromBooking||!imported.ok)throw new Error("Synthetic creation path failed");
 expect(imported.created).toHaveLength(2);
 const created=(await q("SELECT id,patient_number FROM patients WHERE id <> ALL($1::int[]) ORDER BY id",[prior.map(row=>row.id)])).rows;
 expect(created).toHaveLength(12);
 expect(new Set(created.map(row=>row.patient_number)).size).toBe(12);
 for(const row of created)expect(BigInt(String(row.patient_number).slice(2))).toBeGreaterThan(25000n);
 for(const id of [...direct.map(row=>row.id),fromVisit.patientId,fromBooking.patientId])expect(created.some(row=>row.id===id)).toBe(true);
 expect((await q("SELECT patient_id FROM visits WHERE id=$1",[visit.id])).rows).toEqual([{patient_id:fromVisit.patientId}]);
 expect((await q("SELECT patient_id FROM appointments WHERE id=$1",[fromBooking.appointmentId])).rows).toEqual([{patient_id:fromBooking.patientId}]);
 expect((await q("SELECT id,patient_number,patient_number_version::text FROM patients WHERE id=ANY($1::int[]) ORDER BY id",[prior.map(row=>row.id)])).rows).toEqual(prior);
 expect((await q("SELECT * FROM retired_patient_numbers ORDER BY patient_number")).rows).toEqual(history);
 expect((await db.getPatient(high.id))?.patientNumber).toBe("P-25000");
 expect((await q("SELECT aqlan_patient_number_numeric(patient_number) FROM patients WHERE aqlan_patient_number_numeric(patient_number)>0 GROUP BY 1 HAVING count(*)>1")).rows).toEqual([]);
 const next=await numbers.readNumberingPreview(session);
 expect(BigInt(next.nextNumber!.slice(2))).toBeGreaterThan(created.reduce((max,row)=>BigInt(String(row.patient_number).slice(2))>max?BigInt(String(row.patient_number).slice(2)):max,25000n));
});
it("visit and booking conversion reuse an existing low-number patient without renumbering or allocating",async()=>{
 const existing=(await q("SELECT id,patient_number,patient_number_version::text FROM patients WHERE patient_number='P-00042'")).rows[0];
 const sequence=(await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows;
 const count=(await q("SELECT count(*)::int AS n FROM patients")).rows;
 const visit=await db.addVisit({patientName:"Synthetic existing walk-in",patientPhone:"777000111",note:null});
 const request=await db.createBookingRequest({fullName:"Synthetic existing booking",phone:"967777000111",reason:null,preferredDate:"2030-01-03",preferredPeriod:"any"},null);
 const fromVisit=await db.createNextSession({visitId:visit.id,date:"2030-01-03",time:"09:00",durationMinutes:30,phone:null,note:null});
 const fromBooking=await db.confirmBookingRequest({id:request.id,date:"2030-01-03",time:"10:00",durationMinutes:30});
 expect(fromVisit).toMatchObject({patientId:existing.id});
 expect(fromBooking).toMatchObject({patientId:existing.id});
 expect((await q("SELECT id,patient_number,patient_number_version::text FROM patients WHERE id=$1",[existing.id])).rows).toEqual([existing]);
 expect((await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows).toEqual(sequence);
 expect((await q("SELECT count(*)::int AS n FROM patients")).rows).toEqual(count);
});
it("demographic update ignores attempted number and version injection",async()=>{
 const p=await patient(),before=await numbers.readPatientNumber(session,p.id);
 const input={note:"Synthetic permitted demographic update",patientNumber:"150",patient_number:"P-00150",patient_number_version:999};
 expect(await db.updatePatient(p.id,input)).toMatchObject({id:p.id,patientNumber:before.patientNumber,note:input.note});
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
 expect((await q("SELECT * FROM retired_patient_numbers WHERE patient_number=$1",[before.patientNumber])).rows).toEqual([]);
});
it("duplicate merge retains the target file number and retires rather than transfers the source number",async()=>{
 const source=await patient(),target=await patient();
 const targetBefore=await numbers.readPatientNumber(session,target.id);
 const merged=await db.mergeDuplicatePatient(source.id,target.id,{actor:session.username,actorRole:session.role,reason:"Synthetic duplicate only"});
 expect(merged).toMatchObject({ok:true,target:{id:target.id,patientNumber:target.patientNumber}});
 expect(await numbers.readPatientNumber(session,target.id)).toEqual(targetBefore);
 expect(await db.getPatient(source.id)).toBeNull();
 expect((await q("SELECT patient_id::text FROM retired_patient_numbers WHERE patient_number=$1",[source.patientNumber])).rows).toEqual([{patient_id:String(source.id)}]);
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
it("refuses a deferred edit without waiting for a locked patient row",async()=>{
 const p=await patient(), before=await numbers.readPatientNumber(session,p.id), client=await db.getPool().connect();
 let work:Promise<unknown>|undefined;
 try{await client.query("BEGIN");await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[p.id]);
 work=numbers.changePatientNumber(session,p.id,{patientNumber:"998",expectedVersion:before.version,expectedPatientNumber:before.patientNumber,reason:"Synthetic blocked edit"});
 // Await refusal while the row lock is still held: the closed service must not query/wait on it.
 await expect(work).rejects.toMatchObject({code:"forbidden"});
 await client.query("COMMIT");
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
it("refused manual correction preserves approved contract, receipt identities and computed balances",async()=>{
 const {approveAgreement,collectApprovedAgreement,approvedAgreementPosition}=await import("../../lib/approved-agreements");
 const p=await patient();
 await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
 const plan=await db.createPlanV2({patientId:p.id,title:"Synthetic numbering contract",specialty:null,primaryDoctorId:null,
  billingMode:"installments",baseCurrency:"YER",startDate:"2026-10-01",note:null,createdBy:session.username,items:[],
  installments:[{dueDate:"2026-10-01",amountMinor:500},{dueDate:"2026-12-01",amountMinor:500}]});
 expect(plan.ok).toBe(true);if(!plan.ok)throw new Error(plan.message);
 expect(await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null})).toMatchObject({ok:true});
 await approveAgreement({planId:plan.planId,expectedTotalMinor:1000,currency:"YER",source:{kind:"new"},
  reason:"Synthetic paper contract",idempotencyKey:"numbering-contract-approval",session});
 await collectApprovedAgreement({planId:plan.planId,amountMinor:200,currency:"YER",method:"cash",note:null,
  idempotencyKey:"numbering-contract-receipt",session});
 const tables=["invoices","invoice_items","payments","treatment_plans","plan_items","plan_installments",
  "approved_agreement_principals","patient_opening_balances","journal_manual","journal_manual_lines"];
 const financialRows=async()=>{
  const result:Record<string,unknown>={};
  for(const table of tables)result[table]=(await q(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM ${table} t`)).rows[0].rows;
  return result;
 };
 // These witnesses include stored receipt/invoice numbers, stable patient/plan IDs,
 // principal/consent terms, installments and exact balances, not just row counts.
 const rowsBefore=await financialRows(),remaindersBefore=await db.patientReceiptRemainders(p.id);
 const positionBefore=await approvedAgreementPosition(plan.planId,"2026-10-29");
 expect(positionBefore).toMatchObject({remainingMinor:800,dueNowMinor:300});
 const amounts=async()=>db.computeDebtRows([p.id],true);
 const balancesBefore=await amounts();
 expect(balancesBefore).toEqual(expect.arrayContaining([expect.objectContaining({currency:"YER",billedMinor:1000,collectedMinor:200,dueMinor:800})]));
 const before=await numbers.readPatientNumber(session,p.id);
 await expect(edit(p.id,before,"6123")).rejects.toMatchObject({code:"forbidden"});
 expect(await numbers.readPatientNumber(session,p.id)).toEqual(before);
 expect(await financialRows()).toEqual(rowsBefore);
 expect(await db.patientReceiptRemainders(p.id)).toEqual(remaindersBefore);
 expect(await approvedAgreementPosition(plan.planId,"2026-10-29")).toEqual(positionBefore);
 expect(await amounts()).toEqual(balancesBefore);
 expect((await db.getPatient(p.id))?.patientNumber).toBe(before.patientNumber);
});
it("uses indexed max projections and preserves full-width exhaustion without wraparound",async()=>{
 const indexes=(await q("SELECT indexname FROM pg_indexes WHERE tablename IN ('patients','retired_patient_numbers')")).rows.map(r=>r.indexname);
 expect(indexes).toEqual(expect.arrayContaining(["patient_number_numeric_idx","retired_patient_number_numeric_idx"]));
 await q("SELECT setval('patient_number_seq',9223372036854775807,true)");
 expect(await numbers.readNumberingPreview(session)).toMatchObject({exhausted:true,nextNumber:null});
 await expect(patient()).rejects.toMatchObject({code:"2200H"});
});
