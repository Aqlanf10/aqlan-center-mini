import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
const target = validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const reconciliation = await import("../../lib/agreement-reconciliation-db");
const q = async(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let session: SessionPayload;
beforeAll(async () => {
 await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
 const hash = await auth.hashPassword("synthetic-only-reconciliation");
 const [actor] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-reconcile','Synthetic',$1,'admin') RETURNING id", [hash]);
 session = { userId: actor.id, username: "synthetic-reconcile", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now()+3600000 };
 await db.openShift({ openedBy: session.username, opening: {YER:0,SAR:0,USD:0} });
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
let serial = 0;
async function fixture(currency: "YER"|"SAR"|"USD" = "SAR") {
 const n = ++serial;
 const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reconciliation') RETURNING id", [`RECON-${n}`]);
 const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic reconciliation doctor','doctor',30) RETURNING id");
 await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,NULL,'2020-01-01','baseline','Synthetic known policy','synthetic-reconcile')",[doctor.id]);
 const plan = await db.createPlanV2({ patientId:patient.id,title:"Synthetic classic",specialty:null,primaryDoctorId:doctor.id,billingMode:"installments",baseCurrency:currency,startDate:"2026-10-01",note:null,createdBy:session.username,items:[],installments:[{dueDate:"2026-10-01",amountMinor:12000},{dueDate:"2026-11-01",amountMinor:168000}] });
 if (!plan.ok) throw Error(plan.message);
 await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null});
 const payment = await db.recordPlanInstallment({planId:plan.planId,patientId:patient.id,installmentNumber:1,planTitle:"Synthetic classic",amountMinor:12000,currency,baseCurrency:"YER",exchangeRate:currency==="YER"?1:currency==="SAR"?140:530,method:"cash",note:null,createdBy:session.username,actorRole:"admin",idempotencyKey:`recon-source-${n}`});
 if ("reason" in payment) throw Error(payment.reason);
 await q("UPDATE treatment_plans SET status='completed' WHERE id=$1",[plan.planId]);
 return {patientId:patient.id,planId:plan.planId,doctorId:doctor.id,payment};
}
describe("explicit classic agreement reconciliation", () => {
 it("previews completed agreement and posts only unbilled principal exactly once", async () => {
  const f = await fixture();
  const preview = await reconciliation.readAgreementReconciliation(f.planId,session);
  expect(preview).toMatchObject({status:"preview",canConfirm:true,amounts:{agreedMinor:180000,billedPrincipalMinor:12000,unbilledPrincipalMinor:168000,paidMinor:12000,remainingMinor:168000}});
  const before = await q("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id",[f.patientId]);
  const command = {operationKey:"synthetic-reconcile-once",expectedSourceHash:preview.sourceHash,reason:"Synthetic explicit reconciliation"};
  const result = await reconciliation.saveAgreementReconciliation(f.planId,command,session);
  expect(result.reconciliation).toMatchObject({planId:f.planId,patientId:f.patientId,expectedSourceHash:preview.sourceHash,cashMovementMinor:0});
  expect(await reconciliation.saveAgreementReconciliation(f.planId,command,session)).toMatchObject({replayed:true,reconciliation:result.reconciliation});
  expect(await q("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id",[f.patientId])).toEqual(before);
  expect((await q("SELECT sum(total_minor-discount_minor)::text AS principal FROM invoices WHERE patient_id=$1",[f.patientId]))[0].principal).toBe("180000");
  expect(await reconciliation.readAgreementReconciliationAttemptStatus(f.planId,command,session)).toMatchObject({state:"committed",receipt:result.reconciliation});
 });
});
it("keeps stale and competing attempts terminal without billing twice", async () => {
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const first={operationKey:"synthetic-compete-a",expectedSourceHash:preview.sourceHash,reason:"Synthetic competing confirmation"};
 const second={...first,operationKey:"synthetic-compete-b"};
 const results=await Promise.allSettled([reconciliation.saveAgreementReconciliation(f.planId,first,session),reconciliation.saveAgreementReconciliation(f.planId,second,session)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 const statuses=await Promise.all([first,second].map(command=>reconciliation.readAgreementReconciliationAttemptStatus(f.planId,command,session)));
 expect(statuses.map(s=>s.state).sort()).toEqual(["committed","rejected"]);
 const loser=statuses[0].state==="rejected"?first:second;
 await expect(reconciliation.saveAgreementReconciliation(f.planId,loser,session)).rejects.toMatchObject({code:"agreement_source_changed"});
 expect(await q("SELECT id FROM agreement_reconciliations WHERE plan_id=$1",[f.planId])).toHaveLength(1);
 expect((await q("SELECT sum(total_minor-discount_minor)::text AS total FROM invoices WHERE plan_id=$1",[f.planId]))[0].total).toBe("180000");
});
it("rolls back delta and event on actual audit INSERT fault and recovers same command", async () => {
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const command={operationKey:"synthetic-audit-rollback",expectedSourceHash:preview.sourceHash,reason:"Synthetic mandatory audit"};
 await q("CREATE FUNCTION synthetic_reconciliation_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='plan.agreement_reconciliation' THEN RAISE EXCEPTION 'synthetic reconciliation audit fault'; END IF; RETURN NEW; END $$");
 await q("CREATE TRIGGER synthetic_reconciliation_audit_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reconciliation_audit_fault()");
 try { await expect(reconciliation.saveAgreementReconciliation(f.planId,command,session)).rejects.toThrow("synthetic reconciliation audit fault"); }
 finally { await q("DROP TRIGGER synthetic_reconciliation_audit_fault ON audit_log");await q("DROP FUNCTION synthetic_reconciliation_audit_fault()"); }
 expect(await q("SELECT id FROM agreement_reconciliations WHERE plan_id=$1",[f.planId])).toHaveLength(0);
 expect(await q("SELECT id FROM invoices WHERE plan_id=$1",[f.planId])).toHaveLength(1);
 expect(await reconciliation.readAgreementReconciliationAttemptStatus(f.planId,command,session)).toEqual({state:"unresolved"});
 expect(await reconciliation.saveAgreementReconciliation(f.planId,command,session)).toMatchObject({replayed:false});
});
it("refuses changed sources with permanent exact-command no-save proof",async()=>{
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const command={operationKey:"synthetic-stale-source",expectedSourceHash:preview.sourceHash,reason:"Synthetic stale confirmation"};
 await q("UPDATE treatment_plans SET title='Synthetic changed source' WHERE id=$1",[f.planId]);
 await expect(reconciliation.saveAgreementReconciliation(f.planId,command,session)).rejects.toMatchObject({code:"agreement_source_changed"});
 expect(await reconciliation.readAgreementReconciliationAttemptStatus(f.planId,command,session)).toMatchObject({state:"rejected",planId:f.planId,patientId:f.patientId,operationKey:command.operationKey,expectedSourceHash:command.expectedSourceHash});
 await expect(reconciliation.readAgreementReconciliationAttemptStatus(f.planId,{...command,reason:"Different exact intent"},session)).rejects.toMatchObject({code:"operation_key_conflict"});
 expect(await q("SELECT id FROM invoices WHERE plan_id=$1",[f.planId])).toHaveLength(1);
});
it("does not clear a command merely because no transaction has arrived",async()=>{
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const command={operationKey:"synthetic-delayed-request",expectedSourceHash:preview.sourceHash,reason:"Synthetic delayed request"};
 expect(await reconciliation.readAgreementReconciliationAttemptStatus(f.planId,command,session)).toEqual({state:"unresolved"});
 expect(await reconciliation.saveAgreementReconciliation(f.planId,command,session)).toMatchObject({replayed:false});
});
it("protects adopted sources and rejects later classic principal issuance",async()=>{
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:"synthetic-no-reissue",expectedSourceHash:preview.sourceHash,reason:"Synthetic source protection"},session);
 await expect(q("UPDATE invoices SET total_minor=total_minor+1 WHERE plan_id=$1",[f.planId])).rejects.toThrow("reconciled source");
 const [unrelated]=await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYNTHETIC-ATTACH-REFUSE',$1,5000,0,'SAR','open','synthetic-reconcile') RETURNING id",[f.patientId]);
 await expect(q("UPDATE invoices SET plan_id=$1 WHERE id=$2",[f.planId,unrelated.id])).rejects.toThrow("reconciled");
 await q("UPDATE treatment_plans SET status='active' WHERE id=$1",[f.planId]);
 await expect(db.recordPlanInstallment({planId:f.planId,patientId:f.patientId,installmentNumber:2,planTitle:"Synthetic classic",amountMinor:1000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username,actorRole:"admin",idempotencyKey:"synthetic-reissue-refused"})).rejects.toThrow("reconciled agreement");
 expect(await q("SELECT id FROM invoices WHERE plan_id=$1",[f.planId])).toHaveLength(2);
});
it.each(["YER","SAR","USD"] as const)("keeps %s native principal and existing account collection usable",async currency=>{
 const f=await fixture(currency),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const result=await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:`synthetic-currency-${currency}`,expectedSourceHash:preview.sourceHash,reason:"Synthetic native reconciliation"},session);
 expect(await db.getPlan(f.planId,"2026-10-25")).toMatchObject({debtSource:"invoice",progress:{totalMinor:180000,paidMinor:12000,remainingMinor:168000}});
 const payment=await db.recordPayment({patientId:f.patientId,invoiceId:result.reconciliation.deltaInvoiceId,planId:null,kind:"payment",amountMinor:1000,currency,baseCurrency:"YER",exchangeRate:currency==="YER"?1:currency==="SAR"?140:530,method:"cash",note:null,createdBy:session.username,idempotencyKey:`synthetic-new-collection-${currency}`});
 expect(payment.reason).toBeNull();
 expect(payment.payment).not.toBeNull();
 expect(await db.getPlan(f.planId,"2026-10-25")).toMatchObject({debtSource:"invoice",progress:{totalMinor:180000,paidMinor:13000,remainingMinor:167000}});
 expect((await reconciliation.readAgreementReconciliation(f.planId,session)).amounts).toMatchObject({agreedMinor:180000,paidMinor:13000,remainingMinor:167000});
});
it("does not merge an independent invoice into the agreement",async()=>{
 const f=await fixture();
 await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,status,created_by) VALUES('SYNTHETIC-INDEPENDENT',$1,'YER',91000,0,'open','synthetic-reconcile')",[f.patientId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.amounts).toMatchObject({agreedMinor:180000,billedPrincipalMinor:12000,unbilledPrincipalMinor:168000});
 expect(preview.sourceInvoices).toHaveLength(1);
});
it("refuses opening overlap without adding debt",async()=>{
 const f=await fixture();
 await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'SAR',7000,'2026-01-01','synthetic-reconcile')",[f.patientId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.canConfirm).toBe(false);expect(preview.blockers).toContainEqual(expect.objectContaining({code:"opening_overlap"}));
 expect(preview.amounts.remainingMinor).toBeNull();
});
it("allows append-only refund on adopted source without rewriting original principal",async()=>{
 const f=await fixture(),preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:"synthetic-refund-source",expectedSourceHash:preview.sourceHash,reason:"Synthetic refund-compatible reconciliation"},session);
 const shift=await db.getOpenShift();
 await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,plan_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id) VALUES('SYNTHETIC-RECON-REFUND',$1,$2,$3,$4,'refund',2000,'SAR',140,280000,'YER','cash','synthetic-reconcile',$5)",[f.patientId,f.payment.invoiceId,f.planId,shift!.id,f.payment.paymentId]);
 expect(await db.getPlan(f.planId,"2026-10-25")).toMatchObject({progress:{totalMinor:180000,paidMinor:10000,remainingMinor:170000}});
});
it("refuses reset before backup while durable reconciliation or rejection exists",async()=>{
 let backupCalled=false;
 await expect(db.resetClinicData({actor:session.username,actorRole:"admin"},async()=>{backupCalled=true;return {ok:false as const,failure:"must not run"};})).rejects.toThrow("لا يمكن إعادة الضبط");
 expect(backupCalled).toBe(false);
});
it("adopts zero unbilled principal without inventing a zero invoice or commission",async()=>{
 const f=await fixture();
 await q("DELETE FROM plan_installments WHERE plan_id=$1 AND number=2",[f.planId]);
 await q("UPDATE treatment_plans SET total_minor=12000 WHERE id=$1",[f.planId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview).toMatchObject({canConfirm:true,commission:null,amounts:{agreedMinor:12000,billedPrincipalMinor:12000,unbilledPrincipalMinor:0,remainingMinor:0}});
 const result=await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:"synthetic-zero-adoption",expectedSourceHash:preview.sourceHash,reason:"Synthetic full prior principal"},session);
 expect(result.reconciliation.deltaInvoiceId).toBeNull();
 expect(await q("SELECT id FROM invoices WHERE plan_id=$1",[f.planId])).toHaveLength(1);
});

it("serializes classic collection and confirmation without a shift-plan deadlock",async()=>{
 const f=await fixture();await q("UPDATE treatment_plans SET status='active' WHERE id=$1",[f.planId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 const command={operationKey:"synthetic-classic-race",expectedSourceHash:preview.sourceHash,reason:"Synthetic race reconciliation"};
 const blocker=await db.getPool().connect();let confirm:Promise<unknown>|undefined,collect:Promise<unknown>|undefined;
 const waitFor=async(fragment:string)=>{for(let n=0;n<100;n++){await blocker.query("SELECT pg_stat_clear_snapshot()");const {rows}=await blocker.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",[`%${fragment}%`]);if(rows.length)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(`Synthetic lock wait not observed: ${fragment}`);};
 try{
  await blocker.query("BEGIN");await blocker.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE",[f.payment.invoiceId]);
  confirm=reconciliation.saveAgreementReconciliation(f.planId,command,session);void confirm.catch(()=>{});
  await waitFor("SELECT id FROM invoices WHERE patient_id");
  collect=db.recordPlanInstallment({planId:f.planId,patientId:f.patientId,installmentNumber:2,planTitle:"Synthetic classic",amountMinor:1000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username,actorRole:"admin",idempotencyKey:"synthetic-racing-classic-receipt"});void collect.catch(()=>{});
  // Both writers use shift before plan; prove the collector actually overlaps.
  await waitFor("SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1 FOR UPDATE");
  await blocker.query("COMMIT");
  const outcomes=await Promise.allSettled([confirm,collect]);
  for(const outcome of outcomes)if(outcome.status==='rejected')expect(outcome.reason).not.toMatchObject({code:"40P01"});
  expect(outcomes[0].status).toBe("fulfilled");
  expect((await q("SELECT sum(total_minor-discount_minor)::text AS total FROM invoices WHERE plan_id=$1",[f.planId]))[0].total).toBe("180000");
 }finally{await blocker.query("ROLLBACK");blocker.release();await Promise.allSettled([confirm,collect].filter((p):p is Promise<unknown>=>!!p));}
},15000);
it("refuses service-dependent commission rather than guessing a generic delta rate",async()=>{
 const f=await fixture();const {DEFAULT_DOCTOR_COMMISSION_CONFIG}=await import("../../lib/doctor-permissions");
 const config={...DEFAULT_DOCTOR_COMMISSION_CONFIG,calculationMode:"by_category",categoryRates:{ortho:45},deductLabCost:false,rateHistory:[]};
 await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,$2::jsonb,'2026-01-01','advanced','Synthetic source-specific policy','synthetic-reconcile')",[f.doctorId,JSON.stringify(config)]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.canConfirm).toBe(false);expect(preview.blockers).toContainEqual(expect.objectContaining({code:"provider_commission_review"}));
});
it("refuses unallocated foreign-currency receipts without interpreting notes or FX",async()=>{
 const f=await fixture();const shift=await db.getOpenShift();
 await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,status,created_by) VALUES('SYNTHETIC-INDEPENDENT-FX',$1,'YER',91000,0,'open','synthetic-reconcile')",[f.patientId]);
 await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,plan_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,note) VALUES('SYNTHETIC-AMBIGUOUS-FX',$1,NULL,NULL,$2,'payment',7000,'YER',1,7000,'YER','cash','synthetic-reconcile','Synthetic mixed purpose note is not allocation evidence')",[f.patientId,shift!.id]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.canConfirm).toBe(false);expect(preview.blockers).toContainEqual(expect.objectContaining({code:"unallocated_receipt_review"}));
 expect(preview.amounts.paidMinor).toBeNull();
});
it("refuses item-linked principal whose invoice header is not assigned to the plan",async()=>{
 const f=await fixture();
 const [service]=await q("INSERT INTO services(name,price_minor,is_active,price_configured) VALUES('Synthetic linked service',5000,TRUE,TRUE) RETURNING id");
 const [item]=await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,doctor_id) VALUES($1,$2,'Synthetic linked service',1,5000,$3) RETURNING id",[f.planId,service.id,f.doctorId]);
 const [invoice]=await q("INSERT INTO invoices(invoice_number,patient_id,plan_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYNTHETIC-ITEM-SOURCE',$1,NULL,5000,0,'SAR','open','synthetic-reconcile') RETURNING id",[f.patientId]);
 await q("INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,$2,$3,'Synthetic linked service',1,5000,5000,$4)",[invoice.id,service.id,f.doctorId,item.id]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.canConfirm).toBe(false);expect(preview.blockers).toContainEqual(expect.objectContaining({code:"mixed_financial_lineage"}));
});
it("recognizes legacy classic schedule evidence despite the old default billing-mode flag",async()=>{
 const f=await fixture();await q("UPDATE treatment_plans SET billing_mode='per_procedure' WHERE id=$1",[f.planId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 expect(preview.canConfirm).toBe(true);
});
it("rejects new item aliases into adopted plans even with a NULL invoice header",async()=>{
 const f=await fixture();
 const [item]=await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor,doctor_id) VALUES($1,'Synthetic existing work',1,5000,$2) RETURNING id",[f.planId,f.doctorId]);
 const preview=await reconciliation.readAgreementReconciliation(f.planId,session);
 await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:"synthetic-sealed-item-lineage",expectedSourceHash:preview.sourceHash,reason:"Synthetic adopted plan source"},session);
 const [invoice]=await q("INSERT INTO invoices(invoice_number,patient_id,plan_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYNTHETIC-POST-ADOPTION',$1,NULL,5000,0,'SAR','open','synthetic-reconcile') RETURNING id",[f.patientId]);
 await expect(q("INSERT INTO invoice_items(invoice_id,doctor_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,$2,'Synthetic forbidden alias',1,5000,5000,$3)",[invoice.id,f.doctorId,item.id])).rejects.toThrow("reconciled");
 await expect(q("INSERT INTO invoice_items(invoice_id,doctor_id,description,quantity,unit_price_minor,total_minor,source_type,source_id) VALUES($1,$2,'Synthetic forbidden alias',1,5000,5000,'plan_item',$3)",[invoice.id,f.doctorId,item.id])).rejects.toThrow("reconciled");
 await expect(q("UPDATE plan_items SET origin_invoice_id=$1 WHERE id=$2",[invoice.id,item.id])).rejects.toThrow("reconciled");
 await expect(q("UPDATE treatment_plans SET total_from_items=TRUE WHERE id=$1",[f.planId])).rejects.toThrow("reconciled terms");
 await q("UPDATE plan_items SET status='done' WHERE id=$1",[item.id]);
 expect((await q("SELECT status FROM plan_items WHERE id=$1",[item.id]))[0].status).toBe("done");
});
it("round-trips populated reconciliation and tombstones through SQL and full archive with guards enabled",async()=>{
 const {fullBackupBlocks}=await import("../../lib/fullBackup");
 const {parseTarBytes}=await import("../../lib/restore/archive");
 const {validateBackupArchive}=await import("../../lib/restore/validate");
 const before=await q("SELECT id,plan_id,receipt FROM agreement_reconciliations ORDER BY id");
 const rejections=await q("SELECT actor_id,operation_key,request_hash FROM agreement_reconciliation_rejections ORDER BY actor_id,operation_key");
 let sql="";const blocks:Uint8Array[]=[];const source=await db.getPool().connect();
 try {for await(const line of db.backupSqlLines(source))sql+=line;
 for await(const block of fullBackupBlocks({source,readDocument:async()=>{throw Error("Synthetic fixture has no documents");}}))blocks.push(block);
 } finally {source.release();}
 const archive=validateBackupArchive(parseTarBytes(Buffer.concat(blocks)));expect(archive.ok).toBe(true);if(!archive.ok)throw Error(archive.errors.join(";"));
 for(const dump of [sql,Buffer.from(archive.sql).toString("utf8")]){
  await db.resetPoolForTesting();await dropPublicSchema(target.testUrl.toString());
  // Follow official restore: migrate a pristine schema without runtime seed data.
  // Do not disable guards or truncate protected history to prepare a destination.
  const {migrate}=await import("../../lib/migrations");
  const {loadMigrationFiles}=await import("../../lib/migration-files");
  await migrate(db.getPool(),{apply:true,files:await loadMigrationFiles()});
  const {prepareBackupSql}=await import("../../lib/restore/sql.mjs");
  await q("BEGIN; SET CONSTRAINTS ALL DEFERRED; "+prepareBackupSql(dump).dataSql+"; SET CONSTRAINTS ALL IMMEDIATE; COMMIT;");
  expect(await q("SELECT id,plan_id,receipt FROM agreement_reconciliations ORDER BY id")).toEqual(before);
  expect(await q("SELECT actor_id,operation_key,request_hash FROM agreement_reconciliation_rejections ORDER BY actor_id,operation_key")).toEqual(rejections);
  await expect(q("TRUNCATE agreement_reconciliations CASCADE")).rejects.toThrow();
 }
},120000);
