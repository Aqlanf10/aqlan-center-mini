import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {Client,type Pool,type PoolClient} from "pg";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import {loadMigrationFiles,migrate} from "../../lib/migrations";
import {backupSqlLines} from "../../lib/db";
import {fullBackupBlocks} from "../../lib/fullBackup";
import {stagedRestore} from "../../lib/restore/staging";
import {prepareBackupSql} from "../../lib/restore/sql.mjs";
import {LAB_WORK_INTENT_SQL} from "../../lib/lab-work-intent-schema";
import {sessionCredentialVersion,type SessionPayload} from "../../lib/auth";
import {prepareVisitLabWorkInTransaction,recordVisitLabWorkCommandInTransaction} from "../../lib/lab-work-intent-db";
process.env.SESSION_SECRET="synthetic-only-lab-restore-contract-secret-at-least-32";
vi.mock("next/headers",()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let failureFixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let patient:number,otherPatient:number,actor:number,service:number,doctor:number,visit:number,planItem:number;
let sql:string,archivePath:string,directory:string,expected:Record<string,unknown[]>;
const tables=["lab_work_intents","lab_work_members","lab_prescription_source_memberships","lab_work_commands","lab_orders"];
const query=(statement:string,values:unknown[]=[])=>fixture.source.query(statement,values);
async function state(pool:Pool){const result:Record<string,unknown[]>={};for(const table of tables)result[table]=(await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;}
async function transaction<T>(run:(c:PoolClient)=>Promise<T>,isolation="READ COMMITTED"){const c=await fixture.source.connect();try{await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);const value=await run(c);await c.query("COMMIT");return value;}catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}}
async function intent(c:PoolClient,id:string,revision=1,state="draft",order:number|null=null,owner=patient){await c.query(`INSERT INTO lab_work_intents(id,patient_id,origin_kind,origin_visit_id,group_kind,revision,state,prescription,initial_order_id,created_by_user_id)
 VALUES($1,$2,'visit',$3,'single',$4,$5,'{}',$6,$7)`,[id,owner,visit,revision,state,order,actor]);}
async function member(c:PoolClient,id:string,parent:string,created=1,retired:number|null=null,owner=patient,item:number|null=null){await c.query(`INSERT INTO lab_work_members(id,intent_id,patient_id,service_id,source_category,tooth_code,quantity,doctor_id,created_revision,retired_revision,plan_item_id)
 VALUES($1,$2,$3,$4,'crown',27,1,$5,$6,$7,$8)`,[id,parent,owner,service,doctor,created,retired,item]);}
async function alias(c:PoolClient,parent:string,id:string,item=planItem){await c.query(`INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,plan_item_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)`,[parent,id,patient,item,actor]);}
beforeAll(async()=>{
 expect(readFileSync(new URL("../../migrations/0074_lab_work_intents.sql",import.meta.url),"utf8")).toBe(LAB_WORK_INTENT_SQL);
 fixture=await openBackupTimestampFixture({...process.env});failureFixture=await openBackupTimestampFixture({...process.env});
 const files=await loadMigrationFiles();
 for(const pool of [fixture.source,fixture.sqlTarget,failureFixture.sqlTarget])await migrate(pool,{files,apply:true});
 patient=(await query("INSERT INTO patients(patient_number,full_name) VALUES('restore-p1','Synthetic lab restore') RETURNING id")).rows[0].id;
 otherPatient=(await query("INSERT INTO patients(patient_number,full_name) VALUES('restore-p2','Synthetic other patient') RETURNING id")).rows[0].id;
 actor=(await query("INSERT INTO users(username,display_name,password_hash,role) VALUES('restore-lab-actor','Synthetic','synthetic-only','admin') RETURNING id")).rows[0].id;
 doctor=(await query("INSERT INTO parties(name,kind) VALUES('Synthetic doctor','doctor') RETURNING id")).rows[0].id;
 service=(await query("INSERT INTO services(name,category,price_minor) VALUES('Synthetic crown','crown',1000) RETURNING id")).rows[0].id;
 visit=(await query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic lab restore','done') RETURNING id",[patient])).rows[0].id;
 const plan=(await query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'Synthetic lab plan',1000) RETURNING id",[patient])).rows[0].id;
 planItem=(await query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) VALUES($1,$2,'Synthetic crown','crown',27) RETURNING id",[plan,service])).rows[0].id;
 // Produce real historical states through the unchanged parent-first live guards.
 const retiredIntent=randomUUID(),retiredMember=randomUUID();
 await transaction(async c=>{await intent(c,retiredIntent);await member(c,retiredMember,retiredIntent,1,null,patient,planItem);await alias(c,retiredIntent,retiredMember);},"READ COMMITTED");
 await transaction(async c=>{await c.query("UPDATE lab_work_intents SET revision=2 WHERE id=$1",[retiredIntent]);await c.query("UPDATE lab_work_members SET retired_revision=2 WHERE id=$1",[retiredMember]);},"READ COMMITTED");
 for(const cancelled of [false,true])await transaction(async c=>{
  const id=randomUUID();await intent(c,id);await member(c,randomUUID(),id);
  const order=(await c.query(`INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,source,lab_work_intent_id)
   VALUES($1,'Synthetic pending','تاج',CURRENT_DATE,CURRENT_DATE,'needed','auto',$2) RETURNING id`,[patient,id])).rows[0].id;
  await c.query("UPDATE lab_work_intents SET revision=2,state='materialized',initial_order_id=$2 WHERE id=$1",[id,order]);
  if(cancelled){await c.query("UPDATE lab_orders SET status='cancelled' WHERE id=$1",[order]);await c.query("UPDATE lab_work_intents SET revision=3,state='cancelled' WHERE id=$1",[id]);}
 },"READ COMMITTED");
 await query("INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result) VALUES($1,'restore-receipt',$2,'visit',$3,$4,'{\"outcome\":\"rejected\",\"code\":\"stale_intent\"}')",[actor,patient,visit,"a".repeat(64)]);
 expected=await state(fixture.source);sql="";for await(const line of backupSqlLines(fixture.source))sql+=line;
 directory=await mkdtemp(join(tmpdir(),"lab-restore-contract-"));archivePath=join(directory,"synthetic.tar.gz");
 const chunks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source:fixture.source,readDocument:async()=>{throw Error("no synthetic documents");}}))chunks.push(block);
 await writeFile(archivePath,gzipSync(Buffer.concat(chunks)));
},180_000);
afterAll(async()=>{await fixture?.close();await failureFixture?.close();if(directory)await rm(directory,{recursive:true,force:true});},60_000);
describe("lab historical graph restore contract",()=>{
 it("applies 0074 to an existing legacy lab database without backfill or money changes",async()=>{
  const files=await loadMigrationFiles(),target=failureFixture.source;await migrate(target,{files:files.filter(file=>file.version<"0074"),apply:true});
  const owner=(await target.query("INSERT INTO patients(patient_number,full_name) VALUES('legacy-restore-owner','Synthetic legacy') RETURNING id")).rows[0].id;
  await target.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,cost_minor) VALUES($1,'Synthetic legacy lab','تاج',CURRENT_DATE,CURRENT_DATE,'needed',1234)",[owner]);
  const before=(await target.query("SELECT to_jsonb(t)::text AS row FROM lab_orders t")).rows;
  await migrate(target,{files,apply:true});
  expect((await target.query("SELECT (to_jsonb(t)-'lab_work_intent_id')::text AS row FROM lab_orders t")).rows).toEqual(before);
  expect((await target.query("SELECT id FROM lab_work_intents")).rows).toHaveLength(0);
 });
 it("emits a stable graph order and retains target marker ownership",()=>{expect(sql).toContain("BEGIN;");expect(sql).not.toMatch(/INSERT INTO lab_work_intent_schema/);expect(sql.indexOf("INSERT INTO lab_work_members")).toBeLessThan(sql.indexOf("INSERT INTO lab_work_intents"));expect(sql.indexOf("INSERT INTO lab_prescription_source_memberships")).toBeLessThan(sql.indexOf("INSERT INTO lab_work_intents"));expect(sql.indexOf("INSERT INTO lab_work_intents")).toBeLessThan(sql.indexOf("INSERT INTO lab_orders"));});
 it("actual SQL backup restores materialized/cancelled/retired history without rewriting identity",async()=>{await fixture.sqlTarget.query(prepareBackupSql(sql).sql);expect(await state(fixture.sqlTarget)).toEqual(expected);});
 it("actual full archive stages on a fresh target with the same historical graph",async()=>{const result=await stagedRestore({archivePath,targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,"documents")});expect(result.errors).toEqual([]);expect(result.ok).toBe(true);expect(await state(fixture.archiveTarget)).toEqual(expected);},180_000);
 it("occupied target refuses without changing any historical row",async()=>{const before=await state(fixture.sqlTarget);await expect(fixture.sqlTarget.query(prepareBackupSql(sql).sql)).rejects.toThrow();await fixture.sqlTarget.query("ROLLBACK");expect(await state(fixture.sqlTarget)).toEqual(before);});
 it("late orphan failure rolls back every earlier restored application row",async()=>{const parent=randomUUID(),id=randomUUID();const broken=prepareBackupSql(sql).sql.replace(/COMMIT;\s*$/,
  `INSERT INTO lab_work_members(id,intent_id,patient_id,service_id,source_category,tooth_code,quantity,created_revision) VALUES('${id}','${parent}',${patient},${service},'crown',27,1,1); COMMIT;`);
  await expect(failureFixture.sqlTarget.query(broken)).rejects.toThrow();await failureFixture.sqlTarget.query("ROLLBACK");expect((await failureFixture.sqlTarget.query("SELECT id FROM patients")).rows).toHaveLength(0);expect((await failureFixture.sqlTarget.query("SELECT version FROM lab_work_intent_schema")).rows).toEqual([{version:1}]);});
 it("ordinary live parent-first API creation and exact replay remain valid",async()=>{
  const session={userId:actor,username:"restore-lab-actor",role:"admin",expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion("synthetic-only")} as SessionPayload;
  const labWork={intentId:randomUUID(),memberId:randomUUID(),expectedRevision:0,groupKind:"single" as const,prescription:{partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical" as const,priority:"normal" as const}};
  const liveVisit=(await query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic fresh API visit','done') RETURNING id",[patient])).rows[0].id;
  const context={patientId:patient,sourceKind:"visit" as const,sourceId:liveVisit,visitId:liveVisit,session,requestKey:`restore-api-${randomUUID()}`,requestHash:"synthetic exact command"};
  const rows=[{serviceId:service,toothCode:27,quantity:1,planItemId:null,doctorId:doctor,category:"crown",labWork}];
  const first=await transaction(async c=>{const result=await prepareVisitLabWorkInTransaction(c,{...context,rows});await recordVisitLabWorkCommandInTransaction(c,context,result.revisions);return result;},"READ COMMITTED");
  const replay=await transaction(c=>prepareVisitLabWorkInTransaction(c,{...context,rows}),"READ COMMITTED");expect(replay.replayed).toBe(true);expect(replay.revisions).toEqual(first.revisions);
 });
 it("a first-row restore failure leaves the empty application target unchanged",async()=>{
  const broken=prepareBackupSql(sql).sql.replace("BEGIN;", "BEGIN; INSERT INTO lab_work_members(id,intent_id,patient_id,service_id,source_category,tooth_code,quantity,created_revision) VALUES('00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000008',1,1,'crown',9,1,1);");
  await expect(failureFixture.sqlTarget.query(broken)).rejects.toThrow();await failureFixture.sqlTarget.query("ROLLBACK");expect((await failureFixture.sqlTarget.query("SELECT id FROM patients")).rows).toHaveLength(0);
 });
 it.each(["lab_work_intents","lab_work_members","lab_prescription_source_memberships","lab_work_commands"])("refuses populated TRUNCATE of %s without losing history",async table=>{const before=await state(fixture.source);await expect(query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/cannot be truncated/);expect(await state(fixture.source)).toEqual(before);});
 it("permits provably empty history reset on an independently owned empty target",async()=>{const target=failureFixture.archiveTarget;await migrate(target,{files:await loadMigrationFiles(),apply:true});await target.query("TRUNCATE lab_work_intents,lab_work_members,lab_prescription_source_memberships,lab_work_commands,lab_orders,visit_procedures CASCADE");expect((await target.query("SELECT id FROM lab_work_intents")).rows).toHaveLength(0);});
 it.each(["REPEATABLE READ","SERIALIZABLE"])("%s cannot admit missing-parent historical edges",async isolation=>{await expect(transaction(c=>member(c,randomUUID(),randomUUID()),isolation)).rejects.toThrow(/READ COMMITTED identity admission/);});
 it.each([[4,null,3],[1,4,3],[2,1,3]])("refuses invalid created/retired/current revision %j",async(created,retired,current)=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id,created!,retired);await intent(c,id,current!);})).rejects.toThrow();});
 it("rejects orphan parent at COMMIT",async()=>{await expect(transaction(c=>member(c,randomUUID(),randomUUID()))).rejects.toThrow();});
 it("rejects two active single members at COMMIT",async()=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id);await member(c,randomUUID(),id);await intent(c,id);})).rejects.toThrow();});
 it("rejects overlapping historical single-member lifetimes even when both retired",async()=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id,1,3);await member(c,randomUUID(),id,2,4);await intent(c,id,4);})).rejects.toThrow();});
 it("rejects duplicate immutable member identity",async()=>{await expect(transaction(async c=>{const id=randomUUID(),mid=randomUUID();await member(c,mid,id);await member(c,mid,id);await intent(c,id);})).rejects.toThrow();});
 it("rejects source-category/group mismatch at commit",async()=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id);await c.query("INSERT INTO lab_work_intents(id,patient_id,origin_kind,origin_visit_id,group_kind,prescription,created_by_user_id) VALUES($1,$2,'visit',$3,'bridge','{}',$4)",[id,patient,visit,actor]);})).rejects.toThrow();});
 it("rejects cross-patient parent/source ownership",async()=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id,1,null,otherPatient);await intent(c,id);})).rejects.toThrow();});
 it("rejects invalid materialized order reciprocal link",async()=>{await expect(transaction(async c=>{const id=randomUUID();await member(c,randomUUID(),id);await intent(c,id,2,"materialized",2147483000);})).rejects.toThrow();});
 it("rejects reverse orphan order even when its parent UUID exists",async()=>{await expect(transaction(async c=>{const id=randomUUID();await intent(c,id);await member(c,randomUUID(),id);await c.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,lab_work_intent_id) VALUES($1,'Synthetic','تاج',CURRENT_DATE,CURRENT_DATE,'needed',$2)",[patient,id]);})).rejects.toThrow(/reciprocal identity/);});
 it("rejects a reciprocal order belonging to another patient",async()=>{await expect(transaction(async c=>{const id=randomUUID();await intent(c,id);await member(c,randomUUID(),id);const order=(await c.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,lab_work_intent_id) VALUES($1,'Synthetic','تاج',CURRENT_DATE,CURRENT_DATE,'needed',$2) RETURNING id",[otherPatient,id])).rows[0].id;await c.query("UPDATE lab_work_intents SET revision=2,state='materialized',initial_order_id=$2 WHERE id=$1",[id,order]);})).rejects.toThrow();});
 it("rejects an already-owned plan alias on a different explicit member",async()=>{await expect(transaction(async c=>{const id=randomUUID(),mid=randomUUID();await intent(c,id);await member(c,mid,id,1,null,patient,planItem);await alias(c,id,mid);})).rejects.toThrow();});
 it("keeps restored source geometry immutable",async()=>{const row=(await fixture.sqlTarget.query("SELECT id FROM lab_work_members LIMIT 1")).rows[0];await expect(fixture.sqlTarget.query("UPDATE lab_work_members SET tooth_code=28 WHERE id=$1",[row.id])).rejects.toThrow(/cannot be repurposed/);});
 it("existing materialized parent cannot acquire a historical late member",async()=>{const parent=(await query("SELECT id FROM lab_work_intents WHERE state='materialized' LIMIT 1")).rows[0].id;await expect(transaction(c=>member(c,randomUUID(),parent))).rejects.toThrow(/current active draft/);});
 it("existing retired member cannot gain another plan alias",async()=>{const row=(await query("SELECT id,intent_id FROM lab_work_members WHERE retired_revision IS NOT NULL LIMIT 1")).rows[0];await expect(transaction(c=>alias(c,row.intent_id,row.id))).rejects.toThrow(/retired lab member/);});
 it.each(["wrong-plan","wrong-service","wrong-quantity","untyped","contradictory-procedure"])("rejects same-patient invoice alias with %s provenance",async mode=>{
  await expect(transaction(async c=>{
   const id=randomUUID(),mid=randomUUID();const sourcePlan=(await c.query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) SELECT plan_id,service_id,service_name,category,27 FROM plan_items WHERE id=$1 RETURNING id",[planItem])).rows[0].id;await intent(c,id);await member(c,mid,id,1,null,patient,sourcePlan);await alias(c,id,mid,sourcePlan);
   const inv=(await c.query("INSERT INTO invoices(invoice_number,patient_id) VALUES($1,$2) RETURNING id",[randomUUID(),patient])).rows[0].id;
   let itemPlan:number|null=sourcePlan,sourceService=service,quantity=1;
   if(mode==="wrong-plan")itemPlan=(await c.query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) SELECT plan_id,service_id,service_name,category,28 FROM plan_items WHERE id=$1 RETURNING id",[planItem])).rows[0].id;
   if(mode==="wrong-service")sourceService=(await c.query("INSERT INTO services(name,category,price_minor) VALUES('Other crown','crown',1000) RETURNING id")).rows[0].id;
   if(mode==="wrong-quantity")quantity=2;if(mode==="untyped")itemPlan=null;
   const item=(await c.query("INSERT INTO invoice_items(invoice_id,service_id,description,quantity,plan_item_id) VALUES($1,$2,'Synthetic',$3,$4) RETURNING id",[inv,sourceService,quantity,itemPlan])).rows[0].id;
   if(mode==="contradictory-procedure")await c.query("UPDATE invoice_items SET source_type='visit_procedure',source_id=2147483000 WHERE id=$1",[item]);
   await c.query("INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,invoice_item_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)",[id,mid,patient,item,actor]);
  })).rejects.toThrow();
 });
 it.each(["tooth_code", "service_id", "quantity", "category"])("rejects same-patient plan alias with wrong immutable %s",async column=>{
  await expect(transaction(async c=>{const id=randomUUID(),mid=randomUUID();const item=(await c.query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) SELECT plan_id,service_id,service_name,category,27 FROM plan_items WHERE id=$1 RETURNING id",[planItem])).rows[0].id;
   if(column==="service_id") { const otherService=(await c.query("INSERT INTO services(name,category,price_minor) VALUES('Synthetic changed crown','crown',1000) RETURNING id")).rows[0].id;await c.query("UPDATE plan_items SET service_id=$2 WHERE id=$1",[item,otherService]); }
   else if(column==="tooth_code")await c.query("UPDATE plan_items SET tooth_code=28 WHERE id=$1",[item]);
   else if(column==="quantity")await c.query("UPDATE plan_items SET quantity=2 WHERE id=$1",[item]);
   else await c.query("UPDATE plan_items SET category='veneer' WHERE id=$1",[item]);await intent(c,id);await member(c,mid,id,1,null,patient,item);await alias(c,id,mid,item);})).rejects.toThrow(/plan geometry/);
 });
 it.each(["wrong-member","wrong-tooth"])("rejects signed same-patient visit alias with %s",async mode=>{
  await expect(transaction(async c=>{const id=randomUUID(),mid=randomUUID();await intent(c,id);await member(c,mid,id);
   const v=(await c.query("INSERT INTO visits(patient_id,patient_name,status,signed_at) VALUES($1,'Synthetic','done',clock_timestamp()) RETURNING id",[patient])).rows[0].id;
   const proc=(await c.query("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,lab_work_intent_id,lab_work_member_id) VALUES($1,$2,$3,$4,1,$5,$6) RETURNING id",[v,service,doctor,mode==="wrong-tooth"?28:27,mode==="wrong-member"?null:id,mode==="wrong-member"?null:mid])).rows[0].id;
   await c.query("INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,visit_procedure_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)",[id,mid,patient,proc,actor]);
  })).rejects.toThrow(/exact signed member/);
 });
 it.each(["UPDATE lab_work_commands SET result='{}'::jsonb","DELETE FROM lab_work_commands"])("restored terminal receipts refuse direct DML: %s",async statement=>{const before=await state(fixture.sqlTarget);await expect(fixture.sqlTarget.query(statement)).rejects.toThrow(/append-only/);expect(await state(fixture.sqlTarget)).toEqual(before);});
 it.each([false,true])("correction lineage preserves nullable typed provenance; contradictory=%s",async contradictory=>{
  const action=transaction(async c=>{
   const id=randomUUID(),mid=randomUUID();const itemPlan=(await c.query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) SELECT plan_id,service_id,service_name,category,27 FROM plan_items WHERE id=$1 RETURNING id",[planItem])).rows[0].id;
   await intent(c,id);await member(c,mid,id,1,null,patient,itemPlan);await alias(c,id,mid,itemPlan);
   const oldInv=(await c.query("INSERT INTO invoices(invoice_number,patient_id) VALUES($1,$2) RETURNING id",[randomUUID(),patient])).rows[0].id;
   const newInv=(await c.query("INSERT INTO invoices(invoice_number,patient_id) VALUES($1,$2) RETURNING id",[randomUUID(),patient])).rows[0].id;
   const original=(await c.query("INSERT INTO invoice_items(invoice_id,service_id,description,plan_item_id,source_type,source_id) VALUES($1,$2,'Synthetic',$3::int,'plan_item',$3::int) RETURNING id",[oldInv,service,itemPlan])).rows[0].id;
   const replacement=(await c.query("INSERT INTO invoice_items(invoice_id,service_id,description,plan_item_id,source_type,source_id) VALUES($1,$2,'Synthetic',$3,$4,$5) RETURNING id",[newInv,service,itemPlan,contradictory?'visit_procedure':null,contradictory?2147483000:null])).rows[0].id;
   const correction=(await c.query("INSERT INTO invoice_corrections(patient_id,currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by) VALUES($1,'YER',$2,$3,$4,$5,'Synthetic correction','Synthetic') RETURNING id",[patient,oldInv,newInv,randomUUID(),"d".repeat(64)])).rows[0].id;
   await c.query(`INSERT INTO invoice_correction_receipts(correction_id,receipt) SELECT id,jsonb_build_object('patientId',patient_id,'currency',currency,'idempotencyKey',idempotency_key,'createdBy',created_by,'original',jsonb_build_object('id',original_invoice_id,'patientId',patient_id,'baseCurrency',currency),'corrected',jsonb_build_object('id',corrected_invoice_id,'patientId',patient_id,'baseCurrency',currency)) FROM invoice_corrections WHERE id=$1`,[correction]);
   await c.query("INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,plan_item_id,approved_work) VALUES($1,$2,$3,$4,$5::jsonb)",[correction,original,replacement,itemPlan,JSON.stringify({serviceId:service,doctorId:null,quantity:1,unitPriceMinor:0})]);
   await c.query("INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,invoice_item_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)",[id,mid,patient,replacement,actor]);
  });if(contradictory)await expect(action).rejects.toThrow(/correction changes source identity/);else await action;
 });
 it("a second member cannot claim an owned plan through an invoice while omitting its canonical plan alias",async()=>{
  await expect(transaction(async c=>{const id=randomUUID(),mid=randomUUID();await intent(c,id);await member(c,mid,id,1,null,patient,planItem);
   const inv=(await c.query("INSERT INTO invoices(invoice_number,patient_id) VALUES($1,$2) RETURNING id",[randomUUID(),patient])).rows[0].id;
   const item=(await c.query("INSERT INTO invoice_items(invoice_id,service_id,description,plan_item_id) VALUES($1,$2,'Synthetic',$3) RETURNING id",[inv,service,planItem])).rows[0].id;
   await c.query("INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,invoice_item_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)",[id,mid,patient,item,actor]);
  })).rejects.toThrow(/canonical exact plan alias/);
 });
 it("stale REPEATABLE READ emptiness cannot authorize destructive truncation",async()=>{
  const target=failureFixture.archiveTarget;
  const pid=(await target.query("INSERT INTO patients(patient_number,full_name) VALUES('truncate-stale-patient','Synthetic') RETURNING id")).rows[0].id;
  const uid=(await target.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('truncate-stale-user','Synthetic','synthetic','admin') RETURNING id")).rows[0].id;
  const first=await target.connect(),second=new Client({connectionString:target.options.connectionString,ssl:false});await second.connect();
  try{await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ");expect((await first.query("SELECT count(*)::int AS n FROM lab_work_commands")).rows[0].n).toBe(0);
   await second.query("INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result) VALUES($1,'stale-truncate-command',$2,'visit',1,$3,'{}')",[uid,pid,"b".repeat(64)]);
   let refused=false;try{await first.query("TRUNCATE lab_work_commands");}catch{refused=true;}
   await first.query(refused?"ROLLBACK":"COMMIT");
   expect(refused).toBe(true);expect((await second.query("SELECT request_key FROM lab_work_commands")).rows).toEqual([{request_key:"stale-truncate-command"}]);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("SERIALIZABLE empty snapshots cannot authorize truncation",async()=>{
  const c=await failureFixture.source.connect();try{await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");await expect(c.query("TRUNCATE lab_work_commands")).rejects.toThrow(/READ COMMITTED/);}finally{await c.query("ROLLBACK");c.release();}
 });
 it("READ COMMITTED sees a command committed while TRUNCATE waits for its exclusive lock",async()=>{
  const target=failureFixture.source;
  const pid=(await target.query("INSERT INTO patients(patient_number,full_name) VALUES('truncate-wait-patient','Synthetic') RETURNING id")).rows[0].id;
  const uid=(await target.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('truncate-wait-user','Synthetic','synthetic','admin') RETURNING id")).rows[0].id;
  const first=await target.connect(),second=new Client({connectionString:target.options.connectionString,ssl:false});await second.connect();
  try{
   await first.query("BEGIN ISOLATION LEVEL READ COMMITTED");const backend=(await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
   await second.query("BEGIN");await second.query("INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result) VALUES($1,'waiting-truncate-command',$2,'visit',1,$3,'{}')",[uid,pid,"c".repeat(64)]);
   const pending=first.query("TRUNCATE lab_work_commands").then(()=>false,()=>true);
   let waiting=false;const deadline=Date.now()+5000;
   while(Date.now()<deadline){waiting=(await second.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='lab_work_commands'::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting",[backend])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);await second.query("COMMIT");expect(await pending).toBe(true);await first.query("ROLLBACK");
   expect((await second.query("SELECT request_key FROM lab_work_commands")).rows).toEqual([{request_key:"waiting-truncate-command"}]);
  }finally{await second.query("ROLLBACK").catch(()=>{});await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("an unresolved RC member reserves its parent UUID until the same transaction completes",async()=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});
  const id=randomUUID(),mid=randomUUID();
  try{await second.connect();await first.query("BEGIN");await member(first,mid,id);
   await expect(intent(second as unknown as PoolClient,id)).rejects.toMatchObject({code:"55P03"});
   await intent(first,id);await first.query("COMMIT");
   expect((await second.query("SELECT id FROM lab_work_members WHERE id=$1",[mid])).rows).toHaveLength(1);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("a competing same-UUID parent insert fails closed rather than waiting",async()=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});const id=randomUUID();
  try{await second.connect();await first.query("BEGIN");await intent(first,id);
   await expect(intent(second as unknown as PoolClient,id)).rejects.toMatchObject({code:"55P03"});
   await first.query("COMMIT");expect((await second.query("SELECT id FROM lab_work_intents WHERE id=$1",[id])).rows).toHaveLength(1);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("source alias admission takes the same UUID reservation before inspecting the parent",async()=>{
  const id=randomUUID(),mid=randomUUID();const item=(await query("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code) SELECT plan_id,service_id,service_name,category,27 FROM plan_items WHERE id=$1 RETURNING id",[planItem])).rows[0].id;
  await transaction(async c=>{await intent(c,id);await member(c,mid,id,1,null,patient,item);});
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});
  try{await second.connect();await first.query("BEGIN");await first.query("SELECT pg_advisory_xact_lock(hashtext('lab-intent'),hashtext($1))",[id]);
   await expect(alias(second as unknown as PoolClient,id,mid,item)).rejects.toMatchObject({code:"55P03"});
   await first.query("ROLLBACK");await alias(second as unknown as PoolClient,id,mid,item);
   expect((await second.query("SELECT id FROM lab_prescription_source_memberships WHERE member_id=$1",[mid])).rows).toHaveLength(1);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("a pending parent insert refuses a competing member immediately",async()=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});
  const id=randomUUID(),mid=randomUUID();
  try{await second.connect();await first.query("BEGIN");await intent(first,id);
   await expect(member(second as unknown as PoolClient,mid,id)).rejects.toMatchObject({code:"55P03"});
   await first.query("ROLLBACK");expect((await second.query("SELECT id FROM lab_work_members WHERE id=$1",[mid])).rows).toHaveLength(0);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("a committed materialized parent cannot be mistaken for a missing parent at RC",async()=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});
  const id=randomUUID(),mid=randomUUID();
  try{await second.connect();await first.query("BEGIN");await first.query("SELECT count(*) FROM lab_work_intents");
   await second.query("BEGIN");await intent(second as unknown as PoolClient,id);await member(second as unknown as PoolClient,randomUUID(),id);
   const order=(await second.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,lab_work_intent_id) VALUES($1,'Synthetic','تاج',CURRENT_DATE,CURRENT_DATE,'needed',$2) RETURNING id",[patient,id])).rows[0].id;
   await second.query("UPDATE lab_work_intents SET revision=2,state='materialized',initial_order_id=$2 WHERE id=$1",[id,order]);await second.query("COMMIT");
   await expect(member(first,mid,id)).rejects.toThrow(/current active draft/);
  }finally{await first.query("ROLLBACK").catch(()=>{});await second.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it.each(["REPEATABLE READ","SERIALIZABLE"])("%s stale absence cannot attach to an externally committed parent",async isolation=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});const id=randomUUID(),mid=randomUUID();
  try{await second.connect();await first.query(`BEGIN ISOLATION LEVEL ${isolation}`);await first.query("SELECT count(*) FROM lab_work_intents");
   await intent(second as unknown as PoolClient,id);
   await expect(member(first,mid,id)).rejects.toThrow(/READ COMMITTED identity admission/);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
 it("ordinary parent-first graph remains valid in a repeatable-read transaction",async()=>{
  const id=randomUUID(),mid=randomUUID();await transaction(async c=>{await intent(c,id);await member(c,mid,id);},"REPEATABLE READ");
  expect((await query("SELECT id FROM lab_work_members WHERE id=$1",[mid])).rows).toHaveLength(1);
 });
 it("failed missing-parent commit rolls back the edge and releases its UUID",async()=>{
  const id=randomUUID(),mid=randomUUID();await expect(transaction(c=>member(c,mid,id))).rejects.toThrow();
  expect((await query("SELECT id FROM lab_work_members WHERE id=$1",[mid])).rows).toHaveLength(0);
  await transaction(c=>intent(c,id));
 });
 it("rolling back a savepoint discards its edge and releases the missing-parent reservation",async()=>{
  const first=await fixture.source.connect(),second=new Client({connectionString:fixture.source.options.connectionString,ssl:false});const id=randomUUID(),mid=randomUUID();
  try{await second.connect();await first.query("BEGIN");await first.query("SAVEPOINT discarded_graph");await member(first,mid,id);await first.query("ROLLBACK TO SAVEPOINT discarded_graph");
   await intent(second as unknown as PoolClient,id);await first.query("COMMIT");
   expect((await second.query("SELECT id FROM lab_work_members WHERE id=$1",[mid])).rows).toHaveLength(0);
  }finally{await first.query("ROLLBACK").catch(()=>{});first.release();await second.end();}
 });
});
