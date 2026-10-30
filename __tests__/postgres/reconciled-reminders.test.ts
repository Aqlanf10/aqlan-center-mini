import { afterAll, beforeAll, expect, it } from "vitest";
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

async function reconciled() {
 const f = await fixture();
 await q("UPDATE plan_installments SET due_date = CASE WHEN number=1 THEN CURRENT_DATE - 1 ELSE CURRENT_DATE + 30 END WHERE plan_id=$1",[f.planId]);
 const preview = await reconciliation.readAgreementReconciliation(f.planId,session);
 await reconciliation.saveAgreementReconciliation(f.planId,{operationKey:`reminder-reconcile-${serial}`,expectedSourceHash:preview.sourceHash,reason:"Synthetic reminder protection"},session);
 return f;
}
const remind = (planIds:number[], installmentNumber?:number) => db.recordPlanInstallmentReminders({planIds, installmentNumber, bulk:installmentNumber===undefined, actor:session.username,actorRole:session.role});
async function stamps(ids:number[]) {
 return {plans:await q("SELECT id,last_reminder_at FROM treatment_plans WHERE id=ANY($1::int[]) ORDER BY id",[ids]),
 installments:await q("SELECT * FROM plan_installments WHERE plan_id=ANY($1::int[]) ORDER BY id",[ids]),
 audits:await q("SELECT * FROM audit_log WHERE action='plan.installment_reminder' AND entity_id=ANY($1::text[]) ORDER BY id",[ids.map(String)])};
}
it("records one reconciled installment reminder with atomic audit and unchanged financial terms",async()=>{
 const f=await reconciled(); const before=await stamps([f.planId]);
 expect(await remind([f.planId],1)).toMatchObject({updatedCount:1});
 const after=await stamps([f.planId]);
 expect(after.plans[0].last_reminder_at).not.toBeNull();
 expect(after.installments[0].last_reminder_at).toEqual(after.plans[0].last_reminder_at);
 expect(after.installments[1].last_reminder_at).toBeNull();
 expect(after.installments.map(({last_reminder_at:_,...row})=>row)).toEqual(before.installments.map(({last_reminder_at:_,...row})=>row));
 expect(after.audits).toHaveLength(1); expect(after.audits[0].actor).toBe(session.username);
});
it("bulk deduplicates plans, updates only due installments, and audits each existing plan once",async()=>{
 const a=await reconciled(), b=await reconciled();
 expect(await remind([b.planId,a.planId,a.planId,2147483647])).toMatchObject({updatedCount:2});
 for(const id of [a.planId,b.planId]) {
  const after=await stamps([id]); expect(after.audits).toHaveLength(1);
  const due=await q("SELECT last_reminder_at FROM plan_installments WHERE plan_id=$1 AND due_date <= CURRENT_DATE",[id]);
  expect(due.length).toBeGreaterThan(0); expect(due.every(row=>row.last_reminder_at!==null)).toBe(true);
  const future=await q("SELECT last_reminder_at FROM plan_installments WHERE plan_id=$1 AND due_date > CURRENT_DATE",[id]);
  expect(future.length).toBeGreaterThan(0); expect(future.every(row=>row.last_reminder_at===null)).toBe(true);
 }
});
it("missing installment changes neither plan timestamp nor audit",async()=>{
 const f=await reconciled(), before=await stamps([f.planId]);
 expect(await remind([f.planId],99)).toMatchObject({updatedCount:0});
 expect(await stamps([f.planId])).toEqual(before);
});
it("an audit fault on the second plan rolls back the entire batch",async()=>{
 const a=await reconciled(),b=await reconciled(),ids=[a.planId,b.planId],before=await stamps(ids);
 await q(`CREATE FUNCTION synthetic_reminder_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='plan.installment_reminder' AND NEW.entity_id='${b.planId}' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
 await q("CREATE TRIGGER synthetic_reminder_audit_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reminder_audit_fault()");
 try { await expect(remind(ids)).rejects.toThrow("synthetic audit fault"); expect(await stamps(ids)).toEqual(before); }
 finally {await q("DROP TRIGGER synthetic_reminder_audit_fault ON audit_log");await q("DROP FUNCTION synthetic_reminder_audit_fault()");}
 expect(await remind(ids)).toMatchObject({updatedCount:2});
});
it("an installment write fault rolls back plan timestamp and audit",async()=>{
 const f=await reconciled(),before=await stamps([f.planId]);
 await q("CREATE FUNCTION synthetic_reminder_write_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic installment fault'; END $$");
 await q("CREATE TRIGGER synthetic_reminder_write_fault BEFORE UPDATE ON plan_installments FOR EACH ROW EXECUTE FUNCTION synthetic_reminder_write_fault()");
 try { await expect(remind([f.planId],1)).rejects.toThrow("synthetic installment fault"); expect(await stamps([f.planId])).toEqual(before); }
 finally {await q("DROP TRIGGER synthetic_reminder_write_fault ON plan_installments");await q("DROP FUNCTION synthetic_reminder_write_fault()");}
});
it("still refuses every non-reminder schedule column, insert, delete and invoice item mutation",async()=>{
 const f=await reconciled(),other=await fixture();
 const [row]=await q("SELECT * FROM plan_installments WHERE plan_id=$1 ORDER BY number",[f.planId]);
 const changes:Record<string,unknown>={plan_id:other.planId,number:99,due_date:"2030-01-01",amount_minor:1,id:2147483000};
 for(const [column,value] of Object.entries(changes)) await expect(q(`UPDATE plan_installments SET ${column}=$1,last_reminder_at=now() WHERE id=$2`,[value,row.id])).rejects.toThrow("financial review");
 await expect(q("DELETE FROM plan_installments WHERE id=$1",[row.id])).rejects.toThrow("financial review");
 await expect(q("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,99,CURRENT_DATE,1)",[f.planId])).rejects.toThrow("financial review");
 const [source]=await q("SELECT invoice_id FROM agreement_reconciliation_sources WHERE reconciliation_id=(SELECT id FROM agreement_reconciliations WHERE plan_id=$1) LIMIT 1",[f.planId]);
 await expect(q("UPDATE invoice_items SET unit_price_minor=unit_price_minor+1 WHERE invoice_id=$1",[source.invoice_id])).rejects.toThrow("immutable");
});
it("upgrades the published guard without rewriting 0078 registry and is repeatable",async()=>{
 const {readFileSync}=await import("node:fs");
 const {AGREEMENT_REMINDER_GUARD_SQL}=await import("../../lib/agreement-reminder-guard-schema");
 const {applyRuntimeMigrationFiles,checksumOf}=await import("../../lib/migrations");
 const published=readFileSync("migrations/0078_agreement_reconciliation.sql","utf8");
 const originalGuard=published.slice(published.indexOf("CREATE FUNCTION aqlan_reconciliation_terms_guard()"),published.indexOf("CREATE TRIGGER reconciliation_items_guard"));
 const prior=await q("SELECT * FROM schema_migrations WHERE version='0078'");
 const f=await reconciled();
 await q(originalGuard.replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION"));
 await q("DELETE FROM schema_migrations WHERE version='0087'");
 await expect(remind([f.planId],1)).rejects.toThrow("financial review");
 const file={version:"0087",name:"agreement_reminder_metadata",filename:"0087_agreement_reminder_metadata.sql",sql:AGREEMENT_REMINDER_GUARD_SQL,checksum:checksumOf(AGREEMENT_REMINDER_GUARD_SQL)};
 await db.resetPoolForTesting(); await db.ensureSchema();
 const installed=await q("SELECT * FROM schema_migrations WHERE version='0087'");
 await db.resetPoolForTesting(); await db.ensureSchema();
 await applyRuntimeMigrationFiles(db.getPool(),[file]);
 expect(await q("SELECT * FROM schema_migrations WHERE version='0078'")).toEqual(prior);
 expect(await q("SELECT * FROM schema_migrations WHERE version='0087'")).toEqual(installed);
 expect(installed).toHaveLength(1);expect(installed[0].checksum).toBe(file.checksum);
 expect(await remind([f.planId],1)).toMatchObject({updatedCount:1});
});

it("protects a future schedule column rather than using an incomplete field allowlist",async()=>{
 const f=await reconciled();
 await q("ALTER TABLE plan_installments ADD COLUMN synthetic_future_term text");
 try {await expect(q("UPDATE plan_installments SET synthetic_future_term='changed',last_reminder_at=now() WHERE plan_id=$1",[f.planId])).rejects.toThrow("financial review");}
 finally {await q("ALTER TABLE plan_installments DROP COLUMN synthetic_future_term");}
});
