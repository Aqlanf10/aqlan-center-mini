import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
vi.mock("server-only",()=>({}));assertRealPostgresUrl();stubPostgresEnv();vi.stubEnv("SESSION_SECRET","canonical-coverage-status-secret-0123456789");
const db=await import("../../lib/db"),status=await import("../../lib/canonical-ortho-coverage-status"),native=await import("../../lib/ortho-followup-coverage-db");
const GRANTS={"finance.agreements.manage":true,"finance.patient-ledger.view":true};
const ACCOUNTS={owner:{username:"SYN-CST-OWNER",role:"admin"},own:{username:"SYN-CST-OWN",role:"doctor",doctor:true,patientScope:"own",grants:GRANTS},all:{username:"SYN-CST-ALL",role:"reception",patientScope:"all",grants:GRANTS},none:{username:"SYN-CST-NONE",role:"admin",patientScope:"none",grants:GRANTS},unlinked:{username:"SYN-CST-UNLINKED",role:"doctor",patientScope:"own",grants:GRANTS},read:{username:"SYN-CST-READ",role:"admin",patientScope:"all",grants:{"clinical.ortho.view":true}}}as const;
type Key=keyof typeof ACCOUNTS;let fx:CanonicalInventoryDatabase<Key>,side:Pool,sequence=0;
beforeAll(async()=>{fx=await openCanonicalInventoryDatabase(db,ACCOUNTS,"owner");side=new Pool({connectionString:fx.pool.options.connectionString,max:4});},180000);
afterAll(async()=>{await side?.end();await fx?.close();});
async function scenario(owned=true){
 const patient=(await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN patient',$2) RETURNING id",[`SYN-CST-${++sequence}`,owned?fx.parties.own:null])).rows[0].id;
 let snapshot:unknown;
 const observed={query:async(sql:string,values?:unknown[])=>{const result=await fx.pool.query(sql,values);if(sql.startsWith("WITH candidates AS MATERIALIZED"))snapshot=result.rows[0]?.sources?.[0]?.snapshot;return result;}};
 const s=await seedCanonicalCoverage(observed as Pick<Pool,"query">,{patientId:patient,actorId:fx.ids.own,doctorId:fx.parties.own!,save:false});
 const {fingerprint,invoiceNumber:_i,serviceName:_s,...source}=s.source;
 const command:FollowupCoverageCommand={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN explicit routine coverage"};
 return {...s,command,snapshot};
}
type Scenario=Awaited<ReturnType<typeof scenario>>;
const requestFingerprint=(s:Scenario,key:Key)=>createHash("sha256").update(JSON.stringify({patientId:s.patient,orthoCaseId:s.ortho,actorUserId:fx.ids[key],command:s.command})).digest("hex");
const read=async(key:Key,s:Scenario,command:unknown=s.command)=>status.readCanonicalCoverageCommandStatus(await fx.session(key),s.patient,s.ortho,command);
async function committed(s:Scenario,key:Key="own",runner:Pick<Pool,"query">=fx.pool,createdBy:string=ACCOUNTS[key].username){
 return (await runner.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments',$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING id::text`,[s.patient,s.ortho,s.clinical,s.plan,s.item,s.invoice,s.command.decision,s.command.expectedSourceFingerprint,JSON.stringify(s.snapshot),s.command.reason,fx.ids[key],createdBy,s.command.commandId,requestFingerprint(s,key)])).rows[0].id as string;
}
async function rejected(s:Scenario,key:Key="own",message="SYN source no longer current"){
 await fx.pool.query(`INSERT INTO ortho_followup_coverage_rejections(command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,command,code,message,actor)
 VALUES($1,$2,$3,$4,$5,$6::jsonb,'source_changed',$7,$8)`,[s.command.commandId,requestFingerprint(s,key),s.patient,s.ortho,fx.ids[key],JSON.stringify(s.command),message,ACCOUNTS[key].username]);
}
const snapshot=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM ortho_followup_coverage_rejections r) rejections,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM ortho_cases c) cases")).rows;
it.each(["owner","own","all"]as const)("%s reads unresolved without inventing a rejection or changing any nonempty financial/clinical facts",async key=>{const s=await scenario(),before=await snapshot();expect(await read(key,s)).toEqual({state:"unresolved"});expect(await snapshot()).toEqual(before);});
it.each(["none","unlinked","read"]as const)("%s cannot acquire status authority from an adjacent role or permission",async key=>{const s=await scenario();await expect(read(key,s)).rejects.toThrow(/SCOPE|UNLINKED|CAPABILITY/);});
it("outside patient and missing case are indistinguishable",async()=>{const outside=await scenario(false),s=await scenario();await expect(read("own",outside)).rejects.toMatchObject({status:404,code:"coverage_status_unavailable"});await expect(status.readCanonicalCoverageCommandStatus(await fx.session("own"),s.patient,2147483647,{...s.command,source:{...s.command.source,orthoCaseId:2147483647}})).rejects.toMatchObject({status:404,code:"coverage_status_unavailable"});});
it("committed exact actor-bound receipt is a minimal historical outcome, not the current source or financial snapshot",async()=>{const s=await scenario(),id=await committed(s),before=await snapshot(),result=await read("own",s);expect(result).toMatchObject({state:"committed",revision:{id,commandId:s.command.commandId,createdBy:ACCOUNTS.own.username,decision:"included",source:s.command.source}});expect(Object.keys(result).sort()).toEqual(["revision","state"]);expect(JSON.stringify(result)).not.toMatch(/250000|SYN-COV-INVOICE|invoice service|private plan|source_snapshot|request_fingerprint|totalMinor/);expect(await snapshot()).toEqual(before);});
it.each(["owner","all"]as const)("%s cannot read another actor's receipt using its command key",async key=>{const s=await scenario();await committed(s);await expect(read(key,s)).rejects.toMatchObject({code:"command_conflict"});});
it("changed payload cannot replay an existing command receipt",async()=>{const s=await scenario();await committed(s);await expect(read("own",s,{...s.command,decision:"excluded"})).rejects.toMatchObject({code:"command_conflict"});});
it("exact rejection is durable; a missing unrelated command remains unresolved",async()=>{const s=await scenario();await rejected(s);const before=await snapshot();expect(await read("own",s)).toMatchObject({state:"rejected",rejection:{terminal:true,actorUserId:fx.ids.own,command:s.command,code:"source_changed"}});expect(await read("own",s,{...s.command,commandId:randomUUID()})).toEqual({state:"unresolved"});expect(await snapshot()).toEqual(before);});
it("current scope remains necessary after a historical command committed",async()=>{const s=await scenario();await committed(s);await fx.pool.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patient]);await expect(read("own",s)).rejects.toMatchObject({code:"coverage_status_unavailable"});});
it.each(["expire","scope"]as const)("fresh %s after waiting on the actual command fence governs the reply",async kind=>{
 const s=await scenario(),session=await fx.session("own",kind==="expire"?1500:60000),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+s.command.commandId]);pending=status.readCanonicalCoverageCommandStatus(session,s.patient,s.ortho,s.command);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);if(kind==="expire")await new Promise(r=>setTimeout(r,1700));else await holder.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patient]);await holder.query("COMMIT");if(kind==="expire")await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);else await expect(pending).rejects.toMatchObject({code:"coverage_status_unavailable"});}
 finally{await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);}
});
it.each(["COMMIT","ROLLBACK"]as const)("a real receipt writer %s is observed only after its command fence releases",async finish=>{
 const s=await scenario(),session=await fx.session("own"),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+s.command.commandId]);await committed(s,"own",holder);pending=status.readCanonicalCoverageCommandStatus(session,s.patient,s.ortho,s.command);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await holder.query(finish);expect(await pending).toMatchObject({state:finish==="COMMIT"?"committed":"unresolved"});}
 finally{await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);}
});
it.each(["patients","ortho_cases"]as const)("inverse %s lock refuses promptly instead of leaking a partial result",async table=>{
 const s=await scenario(),holder=await side.connect();try{await holder.query("BEGIN");await holder.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table==="patients"?s.patient:s.ortho]);await expect(read("own",s)).rejects.toMatchObject({code:"coverage_status_conflict"});}finally{await holder.query("ROLLBACK");holder.release();}
});
it("revocation behind the identity fence refuses stale and fresh status requests",async()=>{
 const s=await scenario(),session=await fx.session("all"),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"finance.patient-ledger.view":true},patientScope:"all"},2)),fx.ids.all]);pending=status.readCanonicalCoverageCommandStatus(session,s.patient,s.ortho,s.command);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await holder.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(read("all",s)).rejects.toThrow(/CAPABILITY_DENIED/);}
 finally{await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",GRANTS,{patientScope:"all"});}
});
it("expiry after receipt materialization cannot return the otherwise valid outcome",async()=>{
 const s=await scenario();await committed(s);const session=await fx.session("own",1500),original=native.readFollowupCoverageReceiptWith,spy=vi.spyOn(native,"readFollowupCoverageReceiptWith").mockImplementationOnce(async(q,input)=>{const result=await original(q,input);await new Promise(r=>setTimeout(r,1700));return result;});try{await expect(status.readCanonicalCoverageCommandStatus(session,s.patient,s.ortho,s.command)).rejects.toThrow(/SESSION|EXPIRED/);}finally{spy.mockRestore();}
});
it.each(["committed","rejected"]as const)("oversized %s row fails closed before unbounded materialization",async kind=>{const s=await scenario();if(kind==="committed")await committed(s,"own",fx.pool,"x".repeat(20000));else await rejected(s,"own","x".repeat(20000));await expect(read("own",s)).rejects.toMatchObject({code:"coverage_receipt_invalid"});});
it("malformed committed actor cannot masquerade as an exact successful receipt",async()=>{const s=await scenario();await committed(s,"own",fx.pool,"SYN incorrect actor");await expect(read("own",s)).rejects.toMatchObject({code:"coverage_receipt_invalid"});});
it("one owning connection, no initializer, audit, native transaction wrapper or pool query",async()=>{
 const s=await scenario(),session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),audit=vi.spyOn(db,"insertAuditRow"),legacy=vi.spyOn(native,"readFollowupCoverageCommandStatus");try{expect(await status.readCanonicalCoverageCommandStatus(session,s.patient,s.ortho,s.command)).toEqual({state:"unresolved"});expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();audit.mockRestore();legacy.mockRestore();}
});

it("missing active substrate guard fails closed without initialization or fabricated outcome",async()=>{
 const s=await scenario();await fx.pool.query("ALTER TABLE ortho_followup_coverage_rejections DISABLE TRIGGER ortho_followup_rejection_immutable");try{await expect(read("own",s)).rejects.toMatchObject({status:503,code:"coverage_not_ready"});}finally{await fx.pool.query("ALTER TABLE ortho_followup_coverage_rejections ENABLE TRIGGER ortho_followup_rejection_immutable");}
});
