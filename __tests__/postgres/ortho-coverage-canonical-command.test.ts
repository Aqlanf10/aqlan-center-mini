import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
vi.mock("server-only",()=>({}));assertRealPostgresUrl();stubPostgresEnv();vi.stubEnv("SESSION_SECRET","canonical-coverage-command-secret-0123456789");
const db=await import("../../lib/db"),status=await import("../../lib/canonical-ortho-coverage-status"),native=await import("../../lib/ortho-followup-coverage-db"),canonical=await import("../../lib/canonical-ortho-coverage-command");
const GRANTS={"finance.agreements.manage":true,"finance.patient-ledger.view":true};
const ACCOUNTS={owner:{username:"SYN-CAP-OWNER",role:"admin"},own:{username:"SYN-CAP-OWN",role:"doctor",doctor:true,patientScope:"own",grants:GRANTS},all:{username:"SYN-CAP-ALL",role:"reception",patientScope:"all",grants:GRANTS},none:{username:"SYN-CAP-NONE",role:"admin",patientScope:"none",grants:GRANTS},unlinked:{username:"SYN-CAP-UNLINKED",role:"doctor",patientScope:"own",grants:GRANTS},read:{username:"SYN-CAP-READ",role:"admin",patientScope:"all",grants:{"clinical.ortho.view":true}}}as const;
type Key=keyof typeof ACCOUNTS;let fx:CanonicalInventoryDatabase<Key>,side:Pool,sequence=0;
beforeAll(async()=>{fx=await openCanonicalInventoryDatabase(db,ACCOUNTS,"owner");side=new Pool({connectionString:fx.pool.options.connectionString,max:4});},180000);
afterAll(async()=>{await side?.end();await fx?.close();});
async function scenario(owned=true){
 const patient=(await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN patient',$2) RETURNING id",[`SYN-CAP-${++sequence}`,owned?fx.parties.own:null])).rows[0].id;
 let snapshot:unknown;
 const observed={query:async(sql:string,values?:unknown[])=>{const result=await fx.pool.query(sql,values);if(sql.startsWith("WITH candidates AS MATERIALIZED"))snapshot=result.rows[0]?.sources?.[0]?.snapshot;return result;}};
 const s=await seedCanonicalCoverage(observed as Pick<Pool,"query">,{patientId:patient,actorId:fx.ids.own,doctorId:fx.parties.own!,save:false,status:"active"});
 const {fingerprint,invoiceNumber:_i,serviceName:_s,...source}=s.source;
 const command:FollowupCoverageCommand={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN explicit routine coverage"};
 // Seeded open: staging's reopen guard (0125) forbids reopening a closed case without reopen evidence.
 return {...s,command,snapshot};
}
type Scenario=Awaited<ReturnType<typeof scenario>>;
const write=async(key:Key,s:Scenario,command:unknown=s.command)=>canonical.commandCanonicalFollowupCoverage(await fx.session(key),s.patient,s.ortho,command);
const read=async(key:Key,s:Scenario)=>status.readCanonicalCoverageCommandStatus(await fx.session(key),s.patient,s.ortho,s.command);
const financial=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM ortho_cases c) cases,(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v) visits,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_adjustments a) adjustments")).rows;
const effects=async(s:Scenario)=>(await fx.pool.query("SELECT (SELECT count(*)::int FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1) revisions,(SELECT count(*)::int FROM ortho_followup_coverage_rejections WHERE ortho_case_id=$1) rejections,(SELECT count(*)::int FROM audit_log WHERE entity='ortho_case' AND entity_id=$1::text AND action='ortho.followup_coverage.append') audits",[s.ortho])).rows[0];
it.each(["owner","own","all"]as const)("%s records one native decision and one atomic audit without changing nonempty finance or clinical history",async key=>{
 const s=await scenario(),before=await financial(),result=await write(key,s);expect(result).toMatchObject({ok:true,replayed:false,revision:{version:1,decision:"included",createdBy:ACCOUNTS[key].username,commandId:s.command.commandId}});
 expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});expect(await financial()).toEqual(before);
 expect(await read(key,s)).toMatchObject({state:"committed",revision:result.revision});expect(await write(key,s)).toEqual({...result,replayed:true});expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});
 expect(JSON.stringify(result)).not.toMatch(/250000|SYN-COV-INVOICE|invoice service|private plan|source_snapshot|request_fingerprint|totalMinor/);
 const row=(await fx.pool.query("SELECT request_fingerprint,source_snapshot FROM ortho_followup_coverage_revisions WHERE id=$1",[result.revision.id])).rows[0];expect(row.request_fingerprint).toBe(createHash("sha256").update(JSON.stringify({patientId:s.patient,orthoCaseId:s.ortho,actorUserId:fx.ids[key],command:s.command})).digest("hex"));expect(row.source_snapshot).toEqual(s.snapshot);
});
it.each(["none","unlinked","read"]as const)("%s cannot write using a role or adjacent capability",async key=>{const s=await scenario(),before=await financial();await expect(write(key,s)).rejects.toThrow(/SCOPE|UNLINKED|CAPABILITY/);expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});expect(await financial()).toEqual(before);});
it("outside patient and missing case refuse without terminal receipts",async()=>{const s=await scenario(false);await expect(write("own",s)).rejects.toMatchObject({status:404,code:"coverage_command_unavailable"});await expect(canonical.commandCanonicalFollowupCoverage(await fx.session("own"),s.patient,2147483647,{...s.command,source:{...s.command.source,orthoCaseId:2147483647}})).rejects.toMatchObject({status:404,code:"coverage_command_unavailable"});expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});});
it.each(["actor","payload"]as const)("changed %s cannot reuse a successful receipt",async change=>{const s=await scenario();await write("own",s);await expect(write(change==="actor"?"owner":"own",s,change==="payload"?{...s.command,decision:"excluded"}:s.command)).rejects.toMatchObject({code:"command_conflict"});expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});});
it.each(["case_closed","source_changed","stale_coverage"]as const)("%s is a durable audited refusal, queryable and replayable without new effects",async code=>{
 const s=await scenario();let saved=0;if(code==="case_closed")await fx.pool.query("UPDATE ortho_cases SET status='completed' WHERE id=$1",[s.ortho]);
 if(code==="source_changed")s.command.expectedSourceFingerprint="0".repeat(64);
 if(code==="stale_coverage"){await write("own",s);saved=1;s.command={...s.command,commandId:randomUUID(),decision:"excluded"};}
 const before=await financial();await expect(write("own",s)).rejects.toMatchObject({status:409,code,rejection:{terminal:true,command:s.command,actorUserId:fx.ids.own}});expect(await read("own",s)).toMatchObject({state:"rejected",rejection:{code,terminal:true}});await expect(write("own",s)).rejects.toMatchObject({code});expect(await effects(s)).toEqual({revisions:saved,rejections:1,audits:saved+1});expect(await financial()).toEqual(before);
});
it("a fresh explicit superseding decision preserves the prior receipt and signed historical proof",async()=>{
 const s=await scenario(),first=await write("own",s),old=(await fx.pool.query("SELECT to_jsonb(r) row FROM ortho_followup_coverage_revisions r WHERE id=$1",[first.revision.id])).rows;
 const visit=(await fx.pool.query("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('SYN patient',$1,$2,'Routine followup','SYN diagnosis') RETURNING id",[s.patient,fx.parties.own])).rows[0].id;
 const signed=await db.signClinicalVisit({visitId:visit,baseCurrency:"YER",signedBy:ACCOUNTS.owner.username,signerRole:"admin",signerDoctorPartyId:fx.parties.own,orthoSession:{caseId:s.ortho,phase:null,upperWire:null,lowerWire:null,elastics:"none",elasticNote:null,done:"SYN routine adjustment",nextWeeks:4,note:null}});expect(signed.orthoBillingClass).toBe("INCLUDED");expect((await fx.pool.query("SELECT ortho_followup_coverage_proof FROM visits WHERE id=$1",[visit])).rows[0].ortho_followup_coverage_proof).toEqual([{adjustmentId:expect.any(Number),caseId:s.ortho,revisionId:first.revision.id,patientId:s.patient}]);
 const before=await financial();const next=await write("own",s,{...s.command,commandId:randomUUID(),expectedRevisionId:first.revision.id,decision:"excluded",reason:"SYN explicit revised future coverage"});expect(next.revision).toMatchObject({version:2,decision:"excluded",supersedesRevisionId:first.revision.id});expect((await fx.pool.query("SELECT to_jsonb(r) row FROM ortho_followup_coverage_revisions r WHERE id=$1",[first.revision.id])).rows).toEqual(old);expect(await financial()).toEqual(before);expect(await read("own",s)).toMatchObject({state:"committed",revision:first.revision});
});
it.each(["success","rejection"]as const)("audit failure rolls back %s receipt and all effects",async kind=>{
 const s=await scenario();if(kind==="rejection")s.command.expectedSourceFingerprint="0".repeat(64);const before=await financial(),spy=vi.spyOn(db,"insertAuditRow").mockRejectedValueOnce(new Error("SYN audit failed"));try{await expect(write("own",s)).rejects.toThrow("SYN audit failed");}finally{spy.mockRestore();}expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});expect(await read("own",s)).toEqual({state:"unresolved"});expect(await financial()).toEqual(before);
});
it.each(["success","rejection"]as const)("expiry after %s audit rolls back the owning transaction",async kind=>{
 const s=await scenario();if(kind==="rejection")s.command.expectedSourceFingerprint="0".repeat(64);const session=await fx.session("own",1500),original=db.insertAuditRow,spy=vi.spyOn(db,"insertAuditRow").mockImplementationOnce(async(q,a)=>{await original(q,a);await new Promise(r=>setTimeout(r,1700));});try{await expect(canonical.commandCanonicalFollowupCoverage(session,s.patient,s.ortho,s.command)).rejects.toThrow(/SESSION|EXPIRED/);}finally{spy.mockRestore();}expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});
});
it.each(["expire","scope"]as const)("fresh %s after waiting on the actual command fence governs the write",async kind=>{
 const s=await scenario(),session=await fx.session("own",kind==="expire"?1500:60000),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+s.command.commandId]);pending=canonical.commandCanonicalFollowupCoverage(session,s.patient,s.ortho,s.command);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);if(kind==="expire")await new Promise(r=>setTimeout(r,1700));else await holder.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patient]);await holder.query("COMMIT");if(kind==="expire")await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);else await expect(pending).rejects.toMatchObject({code:"coverage_command_unavailable"});}
 finally{await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);}expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});
});
it("revocation behind the identity fence refuses stale and fresh writes, including receipt replay",async()=>{
 const s=await scenario();await write("all",s);const session=await fx.session("all"),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"finance.patient-ledger.view":true},patientScope:"all"},2)),fx.ids.all]);pending=canonical.commandCanonicalFollowupCoverage(session,s.patient,s.ortho,s.command);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await holder.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(write("all",s)).rejects.toThrow(/CAPABILITY_DENIED/);}
 finally{await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",GRANTS,{patientScope:"all"});}expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});
});
it.each(["patients","ortho_cases","plan_items","invoices"]as const)("inverse %s lock refuses promptly without recording a business rejection",async table=>{
 const s=await scenario(),holder=await side.connect();try{await holder.query("BEGIN");await holder.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table==="patients"?s.patient:table==="ortho_cases"?s.ortho:table==="plan_items"?s.item:s.invoice]);await expect(write("own",s)).rejects.toMatchObject({code:"coverage_command_conflict"});expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});}finally{await holder.query("ROLLBACK");holder.release();}
});
it("foreign source IDs cannot lock or disclose the foreign patient's plan item",async()=>{
 const s=await scenario(),other=await scenario(false),holder=await side.connect();s.command={...s.command,source:{...other.command.source,patientId:s.patient,orthoCaseId:s.ortho}};
 try{await holder.query("BEGIN");await holder.query("SELECT id FROM plan_items WHERE id=$1 FOR UPDATE",[other.item]);const before=await financial();await expect(write("own",s)).rejects.toMatchObject({code:"source_changed"});expect(await financial()).toEqual(before);expect(await effects(s)).toEqual({revisions:0,rejections:1,audits:1});}finally{await holder.query("ROLLBACK");holder.release();}
});
it("cancellation after editor snapshot produces a durable source refusal without changing money",async()=>{const s=await scenario();await fx.pool.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[s.invoice]);const before=await financial();await expect(write("own",s)).rejects.toMatchObject({code:"source_changed"});expect(await financial()).toEqual(before);});
it("two actual concurrent identical requests serialize on the native command fence and create exactly once",async()=>{
 const s=await scenario();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),resume=new Promise<void>(r=>{release=r;}),original=db.insertAuditRow;let writerPid=0;
 const spy=vi.spyOn(db,"insertAuditRow").mockImplementationOnce(async(q,a)=>{writerPid=((await q.query("SELECT pg_backend_pid() pid")) as {rows:{pid:number}[]}).rows[0].pid;enter();await resume;return original(q,a);});const first=write("own",s);let second:ReturnType<typeof write>|undefined;
 try{await entered;second=write("own",s);void second.catch(()=>undefined);expect((await waitForBlockedBy(side,writerPid,7000)).length).toBeGreaterThan(0);release();const a=await first,b=await second;expect(b).toEqual({...a,replayed:true});expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});}finally{release();await first.catch(()=>undefined);await second?.catch(()=>undefined);spy.mockRestore();}
});
it("different concurrent editors conflict, then the stale editor is durably refused after the first commits",async()=>{
 const s=await scenario();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),resume=new Promise<void>(r=>{release=r;}),original=db.insertAuditRow;
 const spy=vi.spyOn(db,"insertAuditRow").mockImplementationOnce(async(q,a)=>{enter();await resume;return original(q,a);}),first=write("own",s),other={...s.command,commandId:randomUUID(),decision:"excluded"as const};try{await entered;await expect(write("own",s,other)).rejects.toMatchObject({code:"coverage_command_conflict"});release();await first;await expect(write("own",s,other)).rejects.toMatchObject({code:"stale_coverage"});expect(await effects(s)).toEqual({revisions:1,rejections:1,audits:2});}finally{release();await first.catch(()=>undefined);spy.mockRestore();}
});
it("one owning connection, no initializer, native transaction wrapper or pool query",async()=>{
 const s=await scenario(),session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),legacy=vi.spyOn(native,"appendFollowupCoverage");try{expect(await canonical.commandCanonicalFollowupCoverage(session,s.patient,s.ortho,s.command)).toMatchObject({ok:true});expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();legacy.mockRestore();}
});
it("disabled immutable receipt guard refuses without initialization or effects",async()=>{const s=await scenario();await fx.pool.query("ALTER TABLE ortho_followup_coverage_rejections DISABLE TRIGGER ortho_followup_rejection_immutable");try{await expect(write("own",s)).rejects.toMatchObject({status:503,code:"coverage_not_ready"});expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});}finally{await fx.pool.query("ALTER TABLE ortho_followup_coverage_rejections ENABLE TRIGGER ortho_followup_rejection_immutable");}});
it("a source envelope exceeding 2 MiB fails closed without recording a false business refusal",async()=>{
 const s=await scenario();await fx.pool.query("UPDATE plan_items SET service_name=repeat('x',2100000) WHERE id=$1",[s.item]);await expect(write("own",s)).rejects.toThrow("STAFF_READ_READ_FAILED");expect(await effects(s)).toEqual({revisions:0,rejections:0,audits:0});expect((await fx.pool.query("SELECT length(service_name) n FROM plan_items WHERE id=$1",[s.item])).rows[0].n).toBe(2100000);
});
it("256 source candidates are fully considered; candidate 257 refuses the whole command without truncation",async()=>{
 const s=await scenario();await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
 SELECT $1,$2,$3,'SYN additional candidate','ortho',$4,1,250000,'billed',$5,$5,'invoice',12 FROM generate_series(1,255)`,[s.plan,s.clinical,s.service,fx.parties.own,s.invoice]);const saved=await write("own",s);expect(saved.ok).toBe(true);
 await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
 VALUES($1,$2,$3,'SYN candidate 257','ortho',$4,1,250000,'billed',$5,$5,'invoice',12)`,[s.plan,s.clinical,s.service,fx.parties.own,s.invoice]);await expect(write("own",s,{...s.command,commandId:randomUUID(),expectedRevisionId:saved.revision.id,decision:"excluded"})).rejects.toThrow("STAFF_READ_READ_FAILED");expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:1});expect((await fx.pool.query("SELECT count(*)::int n FROM plan_items WHERE plan_id=$1",[s.plan])).rows[0].n).toBe(257);
});
it("a malformed historical receipt cannot replay as valid success",async()=>{
 const s=await scenario();await fx.pool.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments','included',$7,$8::jsonb,$9,$10,'SYN different actor',$11,$12)`,[s.patient,s.ortho,s.clinical,s.plan,s.item,s.invoice,s.command.expectedSourceFingerprint,JSON.stringify(s.snapshot),s.command.reason,fx.ids.own,s.command.commandId,createHash("sha256").update(JSON.stringify({patientId:s.patient,orthoCaseId:s.ortho,actorUserId:fx.ids.own,command:s.command})).digest("hex")]);await expect(write("own",s)).rejects.toMatchObject({code:"coverage_receipt_invalid"});expect(await effects(s)).toEqual({revisions:1,rejections:0,audits:0});
});
it("source ownership changing after preflight cannot lock a now-foreign plan item",async()=>{
 const s=await scenario(),outside=await scenario(false),holder=await side.connect(),original=native.appendFollowupCoverageWith;let changed=false;
 const spy=vi.spyOn(native,"appendFollowupCoverageWith").mockImplementationOnce(async(client,...args)=>{
  const query=(async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(!changed&&sql.startsWith("WITH candidates AS MATERIALIZED")){changed=true;await side.query("UPDATE treatment_plans SET patient_id=$1 WHERE id=$2",[outside.patient,s.plan]);await holder.query("BEGIN");await holder.query("SELECT id FROM plan_items WHERE id=$1 FOR UPDATE",[s.item]);}return result;}) as typeof client.query;
  return original({...client,query},...args);
 });
 try{await expect(write("own",s)).rejects.toMatchObject({code:"source_changed"});expect(changed).toBe(true);expect(await effects(s)).toEqual({revisions:0,rejections:1,audits:1});}finally{spy.mockRestore();await holder.query("ROLLBACK");holder.release();}
});
