import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { INVOICE_CORRECTION_SQL } from "../../lib/invoice-correction-schema";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import { durableInvoiceRevision, readInvoiceRevisionReceipt, readInvoiceRevisionView, restoreInvoiceRevision, type InvoiceRevisionCommand } from "../../lib/invoice-revision-view";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv, createIsolatedDatabase, adminClient } from "./_setup";
import type { DebtRepaymentTerms } from "../../lib/debt-installments";
import type { SessionPayload } from "../../lib/auth";
import { toInputAmount, type Currency } from "../../lib/money";
import { readSavedRepaymentAgreement } from "../../lib/debt-repayment-agreement-db";
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const revision = await import("../../lib/invoice-revision-db");
const debt = await import("../../lib/debt-installments-db");
const linked = await import("../../lib/invoice-linkage-db");
const { DEFAULT_SPECIALTY_TEMPLATES } = await import("../../lib/specialty-templates");
let session: SessionPayload, serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql,values)).rows;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  const password = await auth.hashPassword("synthetic-revision-test");
  const user = (await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('revision-owner','Synthetic revision owner',$1,'admin',TRUE) RETURNING id",[password]))[0];
  session = { userId:user.id, username:"revision-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(password),expiresAt:Date.now()+3_600_000 };
  await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
},180_000);
afterAll(async () => { await db.resetPoolForTesting(); });
const terms = (amount: number):DebtRepaymentTerms => amount > 0 ? { mode:"installments",installments:[{dueDate:"2026-11-14",kind:"installment",amountMinor:amount}] } : { mode:"full",installments:[] };
async function fixture(paid = 0, currency: Currency = "YER") {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic correction') RETURNING id",[`INV-REV-${++serial}`]))[0].id;
  const invoice = await db.createInvoice({patientId,baseCurrency:currency,discountMinor:0,note:null,createdBy:session.username,
    items:[{serviceId:null,doctorId:null,description:"Synthetic financial item",quantity:1,unitPriceMinor:10000}]});
  if (!invoice) throw new Error("fixture invoice missing");
  if (paid) {
    const receipt = await db.recordPayment({patientId,invoiceId:invoice.id,kind:"payment",amountMinor:paid,currency,baseCurrency:currency,
      exchangeRate:1,method:"cash",note:null,createdBy:session.username,idempotencyKey:`revision-paid-${serial}`});
    expect(receipt.reason).toBeNull();
  }
  return invoice;
}
async function command(invoiceId: number, after: number) {
  const view = await revision.readInvoiceRevision(invoiceId,session);
  const remaining = Math.max(0,after-view.settledMinor);
  return {idempotencyKey:`invoice-revision-test-${++serial}`,expectedSourceHash:view.sourceHash,reason:"Correct documented agreement amount",
    lines:view.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:toInputAmount(after,view.invoice.baseCurrency)})),
    discount:"0",discountReason:null,repaymentTerms:terms(remaining),expectedRemainingMinor:remaining};
}

describe("immutable invoice replacement and original receipt settlement", () => {
  it.each((["YER","SAR","USD"] as const).flatMap(currency=>[0,4000,10000].map(paid=>({currency,paid}))))("$currency increases and decreases an invoice with $paid already paid without moving receipts or duplicating debt",async ({currency,paid}) => {
    for (const after of [6000,14000]) {
      const invoice = await fixture(paid,currency);
      const originalSchedule = paid < 10000 ? await debt.saveDebtRepayment({target:{patientId:invoice.patientId,currency,invoiceId:invoice.id,openingCurrency:null},
        terms:terms(10000-paid),expectedVersion:0,expectedRemainingMinor:10000-paid,reason:"Synthetic original dated agreement",idempotencyKey:`initial-revision-schedule-${++serial}`,session}) : null;
      if(originalSchedule)expect(await readSavedRepaymentAgreement(originalSchedule.arrangementId,1,"2026-10-14")).not.toBeNull();
      const cashBefore=(await db.getOpenShift())!.expected;
      const receipts = await q("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id",[invoice.patientId]);
      const input = await command(invoice.id,after);
      const view=readInvoiceRevisionView(await revision.readInvoiceRevision(invoice.id,session),invoice.patientId,invoice.id)!;
      expect(view).not.toBeNull();
      const retained:InvoiceRevisionCommand={key:input.idempotencyKey,actor:session.username,patientId:invoice.patientId,invoiceId:invoice.id,body:JSON.stringify(input),
        expected:{original:view.invoice,lines:view.invoice.items.map(item=>({...item,unitPriceMinor:after,totalMinor:after})),discountMinor:0,settledMinor:paid,accountDueMinor:view.accountDueMinor,terms:input.repaymentTerms as InvoiceRevisionCommand["expected"]["terms"]},outcome:"pending",message:""};
      expect(restoreInvoiceRevision(durableInvoiceRevision(retained),invoice.patientId,session.username)).toMatchObject({body:retained.body,outcome:"uncertain"});
      expect(()=>restoreInvoiceRevision(durableInvoiceRevision(retained),invoice.patientId+1,session.username)).toThrow();
      const result = await revision.reviseInvoice(invoice.id,input,session);
      expect(readInvoiceRevisionReceipt(result,retained)).not.toBeNull();
      expect(readInvoiceRevisionReceipt({...result,patientId:invoice.patientId+1},retained)).toBeNull();
      expect(readInvoiceRevisionReceipt({...result,settledMinor:paid+1},retained)).toBeNull();
      expect(result).toMatchObject({replayed:false,patientId:invoice.patientId,beforeMinor:10000,afterMinor:after,settledMinor:paid,
        remainingMinor:Math.max(0,after-paid),creditMinor:Math.max(0,paid-after),accountDueMinor:after-paid});
      const corrected = (await q("SELECT corrected_invoice_id FROM invoice_corrections WHERE original_invoice_id=$1",[invoice.id]))[0].corrected_invoice_id;
      const client = await db.getPool().connect();
      try { expect(await debt.readDebtPosition(client,{patientId:invoice.patientId,currency,invoiceId:corrected,openingCurrency:null}))
        .toMatchObject({principalMinor:after,settledMinor:paid,remainingMinor:Math.max(0,after-paid)}); } finally { client.release(); }
      expect(await q("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).toEqual(receipts);
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1 AND status<>'cancelled'",[invoice.patientId])).toHaveLength(1);
      expect(await q("SELECT id FROM audit_log WHERE action='invoice.correct' AND entity_id=$1",[String(invoice.id)])).toHaveLength(1);
      const replay=await revision.reviseInvoice(invoice.id,input,session);
      expect(replay).toEqual({...result,replayed:true});
      expect(readInvoiceRevisionReceipt(replay,retained)).not.toBeNull();
      const workspace = await debt.debtRepaymentWorkspace(invoice.patientId,"2026-10-14");
      expect(workspace.targets.reduce((sum,target)=>sum+target.remainingMinor,0)).toBe(Math.max(0,after-paid));
      if(originalSchedule)expect(await readSavedRepaymentAgreement(originalSchedule.arrangementId,1,"2026-10-14")).toBeNull();
      const active=workspace.arrangements.filter(row=>row.status==="active"&&row.terms.mode==="installments");
      expect(active).toHaveLength(after>paid?1:0);
      if(active[0]){
        const printable=await readSavedRepaymentAgreement(active[0].id,active[0].version,"2026-10-14");
        expect(printable?.schedule).toMatchObject({target:{currency,invoiceId:corrected},principalMinor:after,collectedMinor:paid,remainingMinor:after-paid});
        expect(printable?.source.invoice_number).toBe((await db.getInvoice(corrected))!.invoiceNumber);
      }
      const ledger=await db.patientLedger(invoice.patientId);
      const balances=db.ledgerBalancesByCurrency(invoice.patientId,ledger,new Map());
      expect(balances[currency]).toMatchObject({billedMinor:after,collectedMinor:paid,dueMinor:after-paid});
      for(const other of (["YER","SAR","USD"] as const).filter(code=>code!==currency))expect(balances[other]).toMatchObject({billedMinor:0,collectedMinor:0,dueMinor:0});
      expect((await db.getOpenShift())!.expected).toEqual(cashBefore);
      if(paid>0&&active[0]){
        const originalPayment=ledger.payments.find(row=>row.kind==="payment")!;
        const refund=await db.recordPayment({patientId:invoice.patientId,invoiceId:invoice.id,kind:"refund",amountMinor:1000,currency,baseCurrency:currency,
          exchangeRate:1,method:"cash",note:"Synthetic explicit ancestor refund",createdBy:session.username,reversalOfId:originalPayment.id,idempotencyKey:`revision-explicit-refund-${++serial}`});
        expect(refund.reason).toBeNull();
        expect(await readSavedRepaymentAgreement(active[0].id,active[0].version,"2026-10-14")).toBeNull();
        const refundedLedger=await db.patientLedger(invoice.patientId);
        expect(db.ledgerBalancesByCurrency(invoice.patientId,refundedLedger,new Map())[currency]).toMatchObject({billedMinor:after,collectedMinor:paid-1000,dueMinor:after-paid+1000});
        const cashAfter=(await db.getOpenShift())!.expected;
        for(const code of ["YER","SAR","USD"] as const)expect(cashAfter[code]).toBe(cashBefore[code]-(code===currency?1000:0));
        expect(refundedLedger.payments.find(row=>row.id===originalPayment.id)?.invoiceId).toBe(invoice.id);
      }
    }
  });
  it("replays one concurrent command, rejects changed intent and a stale second command",async () => {
    const invoice = await fixture(4000); const input = await command(invoice.id,12000);
    const results = await Promise.all([revision.reviseInvoice(invoice.id,input,session),revision.reviseInvoice(invoice.id,input,session)]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
    expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[invoice.patientId])).toHaveLength(1);
    await expect(revision.reviseInvoice(invoice.id,{...input,reason:"Different correction intent"},session)).rejects.toMatchObject({code:"conflict"});
    await expect(revision.reviseInvoice(invoice.id,{...input,idempotencyKey:`another-${input.idempotencyKey}`},session)).rejects.toMatchObject({code:"conflict"});
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[invoice.patientId])).toHaveLength(2);
  });
  it("successive replacements inherit the original SAR settlement without creating currency conversion or another receipt",async () => {
    const invoice = await fixture(4000,"SAR");
    await revision.reviseInvoice(invoice.id,await command(invoice.id,12000),session);
    const first = (await q("SELECT corrected_invoice_id FROM invoice_corrections WHERE original_invoice_id=$1",[invoice.id]))[0].corrected_invoice_id;
    const view = await revision.readInvoiceRevision(first,session); expect(view.settledMinor).toBe(4000);
    const input = await command(first,3000);
    expect(await revision.reviseInvoice(first,input,session)).toMatchObject({currency:"SAR",settledMinor:4000,remainingMinor:0,creditMinor:1000,accountDueMinor:-1000});
    expect(await q("SELECT invoice_id,currency,amount_minor::text FROM payments WHERE patient_id=$1",[invoice.patientId]))
      .toEqual([{invoice_id:invoice.id,currency:"SAR",amount_minor:"4000"}]);
    const schedules = await debt.listDebtRepayments(invoice.patientId,"2026-10-14");
    expect(schedules.filter(schedule=>schedule.status==="active")).toHaveLength(0);
  });
  it("rejects invalid terms, revoked authority and locked periods before replacement",async () => {
    const invoice = await fixture(); const input = await command(invoice.id,12000);
    await expect(revision.reviseInvoice(invoice.id,{...input,repaymentTerms:terms(11999)},session)).rejects.toMatchObject({code:"invalid"});
    await expect(revision.reviseInvoice(invoice.id,input,{...session,role:"reception"})).rejects.toMatchObject({code:"unauthorized"});
    await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
    try { await expect(revision.reviseInvoice(invoice.id,input,session)).rejects.toMatchObject({code:"unauthorized"}); }
    finally { await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]); }
    await q("INSERT INTO settings(key,value) VALUES('finance.locked_before','2099-01-01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    try { await expect(revision.reviseInvoice(invoice.id,input,session)).rejects.toMatchObject({code:"conflict"}); }
    finally { await q("DELETE FROM settings WHERE key='finance.locked_before'"); }
    expect(await q("SELECT id,status FROM invoices WHERE patient_id=$1",[invoice.patientId])).toEqual([{id:invoice.id,status:"open"}]);
    expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[invoice.patientId])).toHaveLength(0);
  });
  it("revises a linked clinical price with one plan/case, preserves assessment work, and requires exact immutable approval for coverage",async () => {
    const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic clinical revision') RETURNING id",[`INV-REV-CL-${++serial}`]))[0].id;
    const doctor = (await q("INSERT INTO parties(name,kind) VALUES('Synthetic revision doctor','doctor') RETURNING id"))[0].id;
    const service = (await q("INSERT INTO services(name,category,price_minor,is_active) VALUES('Synthetic revised endodontics','rct',10000,TRUE) RETURNING id"))[0].id;
    const issued = await linked.createLinkedInvoice({patientId,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,actorRole:"admin",
      items:[{serviceId:service,category:"rct",doctorId:doctor,description:"Synthetic revised endodontics",quantity:1,unitPriceMinor:10000,toothCode:36,caseId:null,sessions:null}],
      templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{}});
    expect(issued.ok).toBe(true); if (!issued.ok) return;
    const item = issued.links[0].planItemId!;
    const visit = (await q("INSERT INTO visits(patient_id,patient_name,case_id) VALUES($1,'Synthetic assessment',$2) RETURNING id",[patientId,issued.links[0].caseId]))[0].id;
    await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,unit_price_minor,plan_item_id,note) VALUES($1,$2,$3,36,1,10000,$4,'Preserve clinical draft')",[visit,service,doctor,item]);
    const draft = await q("SELECT to_jsonb(p) AS value FROM visit_procedures p WHERE visit_id=$1",[visit]);
    await revision.reviseInvoice(issued.invoice.id,await command(issued.invoice.id,12000),session);
    expect(await q("SELECT to_jsonb(p) AS value FROM visit_procedures p WHERE visit_id=$1",[visit])).toEqual(draft);
    const correctedId = (await q("SELECT corrected_invoice_id FROM invoice_corrections WHERE original_invoice_id=$1",[issued.invoice.id]))[0].corrected_invoice_id;
    expect((await db.getInvoice(correctedId))?.items[0]).toMatchObject({planItemId:item,caseId:issued.links[0].caseId,unitPriceMinor:12000,financialReviewRequired:false});
    expect(await q("SELECT id,total_minor::text FROM treatment_plans WHERE patient_id=$1",[patientId])).toEqual([{id:issued.planId,total_minor:"12000"}]);
    expect(await q("SELECT id FROM clinical_cases WHERE patient_id=$1",[patientId])).toHaveLength(1);
    const input = await command(correctedId,6000);
    await expect(revision.reviseInvoice(correctedId,{...input,lines:[{...input.lines[0],quantity:2}],
      expectedRemainingMinor:12000,repaymentTerms:terms(12000)},session)).rejects.toMatchObject({code:"conflict"});
    await expect(q("UPDATE invoice_correction_lines SET approved_work='{}'::jsonb WHERE plan_item_id=$1",[item])).rejects.toThrow(/append-only/);
    await q("UPDATE plan_items SET unit_price_minor=12001 WHERE id=$1",[item]);
    expect((await db.getInvoice(correctedId))?.items[0].financialReviewRequired).toBe(true);
  });
  it.each(["structured-endo","case-assessment"])("protects %s evidence before any clinical visit exists while allowing an audited price correction",async evidence => {
    const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic pre-visit clinical evidence') RETURNING id",[`INV-REV-DRAFT-${++serial}`]))[0].id;
    const serviceId=(await q("INSERT INTO services(name,category,price_minor,is_active) VALUES('Synthetic pre-visit root treatment','rct',10000,TRUE) RETURNING id"))[0].id;
    const doctorId=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic pre-visit treating doctor','doctor') RETURNING id"))[0].id;
    const issued=await linked.createLinkedInvoice({patientId,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,actorRole:"admin",
      items:[{serviceId,category:"rct",doctorId,description:"Synthetic pre-visit root treatment",quantity:1,unitPriceMinor:10000,toothCode:36,caseId:null,sessions:null}],
      templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{}});
    if(!issued.ok)throw new Error("Expected linked clinical invoice");
    const item=issued.links[0].planItemId!,caseId=issued.links[0].caseId!;
    if(evidence==="structured-endo"){
      const endo=await import("../../lib/endodontics-db");
      expect(await endo.openEndoTreatment({patientId,caseId,toothCode:36,kind:"initial",actor:session.username,actorRole:session.role})).toMatchObject({ok:true});
    }else await q("UPDATE clinical_cases SET problem='Synthetic saved clinical assessment' WHERE id=$1",[caseId]);
    const beforeCase=await q("SELECT to_jsonb(c) AS evidence FROM clinical_cases c WHERE id=$1",[caseId]);
    const beforeEndo=await q("SELECT to_jsonb(e) AS evidence FROM endo_treatments e WHERE patient_id=$1",[patientId]);
    const view=await revision.readInvoiceRevision(issued.invoice.id,session);expect(view.work).toEqual([expect.objectContaining({id:item,clinical_locked:true})]);
    const request=await command(issued.invoice.id,10000);
    await expect(revision.reviseInvoice(issued.invoice.id,{...request,lines:[{...request.lines[0],quantity:2}],expectedRemainingMinor:20000,repaymentTerms:terms(20000)},session)).rejects.toMatchObject({code:"conflict"});
    expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[patientId])).toHaveLength(0);
    await revision.reviseInvoice(issued.invoice.id,await command(issued.invoice.id,12000),session);
    expect(await q("SELECT to_jsonb(c) AS evidence FROM clinical_cases c WHERE id=$1",[caseId])).toEqual(beforeCase);
    expect(await q("SELECT to_jsonb(e) AS evidence FROM endo_treatments e WHERE patient_id=$1",[patientId])).toEqual(beforeEndo);
    expect(await q("SELECT id FROM visits WHERE patient_id=$1",[patientId])).toHaveLength(0);
    expect(await q("SELECT quantity,case_id FROM plan_items WHERE id=$1",[item])).toEqual([{quantity:1,case_id:caseId}]);
  });
  it("restores correction lineage, immutable receipt acknowledgements and original payments through the canonical backup",async () => {
    expect(readFileSync("migrations/0061_invoice_correction_lineage.sql","utf8")).toBe(INVOICE_CORRECTION_SQL);
    const tables=["invoice_corrections","invoice_correction_lines","invoice_correction_receipts","payments","debt_repayment_revisions"];
    const snapshots=await Promise.all(tables.map(table=>q(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY ${table==="invoice_correction_receipts"?"correction_id":"id"}`)));
    const chunks:string[]=[];for await(const chunk of db.backupSnapshotSqlLines(db.getPool()))chunks.push(chunk);
    const name="aqlan_invoice_revision_restore_test";const restored=new Pool({connectionString:await createIsolatedDatabase(name),ssl:false});
    try {
      await migrate(restored as unknown as Parameters<typeof migrate>[0],{apply:true,files:await loadMigrationFiles()});
      const registry=(await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows;
      await restored.query(prepareBackupSql(chunks.join("")).sql);
      expect((await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows).toEqual(registry);
      for(const [index,table] of tables.entries())expect((await restored.query(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY ${table==="invoice_correction_receipts"?"correction_id":"id"}`)).rows).toEqual(snapshots[index]);
    } finally {await restored.end();const admin=adminClient("postgres");await admin.connect();try{await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);}finally{await admin.end();}}
  },120000);
});


describe("safe pre-treatment clinical identity correction",()=>{
  async function identityFixture(){
    const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic identity correction') RETURNING id",[`IDENTITY-${++serial}`]))[0].id;
    const doctor=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic original doctor','doctor') RETURNING id"))[0].id;
    const nextDoctor=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic corrected doctor','doctor') RETURNING id"))[0].id;
    const service=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic original root canal','rct',10000,TRUE,TRUE) RETURNING id"))[0].id;
    const nextService=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic corrected root canal','rct',10000,TRUE,TRUE) RETURNING id"))[0].id;
    const issued=await linked.createLinkedInvoice({patientId,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,actorRole:"admin",
      items:[{serviceId:service,category:"rct",doctorId:doctor,description:"Synthetic original root canal",quantity:1,unitPriceMinor:10000,toothCode:36,caseId:null,sessions:null}],
      templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{}});
    if(!issued.ok)throw new Error("Fixture linked invoice");
    return {patientId,doctor,nextDoctor,service,nextService,issued};
  }
  it("amends service/provider/tooth once, retaining original print identity and one canonical item/case",async()=>{
    const {patientId,doctor,nextDoctor,service,nextService,issued}=await identityFixture();
    const input=await command(issued.invoice.id,12000);
    const change={...input,lines:[{...input.lines[0],serviceId:nextService,doctorId:nextDoctor,toothCode:46,surfaces:null}]};
    const result=await revision.reviseInvoice(issued.invoice.id,change,session);
    expect(result).toMatchObject({original:{items:[{serviceId:service,doctorId:doctor,toothCode:36}]},corrected:{items:[{serviceId:nextService,doctorId:nextDoctor,toothCode:46,planItemId:issued.links[0].planItemId,caseId:issued.links[0].caseId,financialReviewRequired:false}]}});
    expect((await db.getInvoice(issued.invoice.id))?.items[0]).toMatchObject({serviceId:service,doctorId:doctor,toothCode:36});
    expect(await q("SELECT id,site,responsible_party_id FROM clinical_cases WHERE patient_id=$1",[patientId])).toEqual([{id:issued.links[0].caseId,site:"46",responsible_party_id:nextDoctor}]);
    expect(await q("SELECT id FROM plan_items WHERE plan_id=$1",[issued.planId])).toEqual([{id:issued.links[0].planItemId}]);
    const expectedLine={...issued.invoice.items[0],serviceId:nextService,doctorId:nextDoctor,toothCode:46,description:"Synthetic corrected root canal",unitPriceMinor:12000,totalMinor:12000};
    const lease:InvoiceRevisionCommand={key:change.idempotencyKey,actor:session.username,patientId,invoiceId:issued.invoice.id,body:JSON.stringify(change),
      expected:{original:issued.invoice,lines:[expectedLine],discountMinor:0,settledMinor:0,accountDueMinor:10000,terms:input.repaymentTerms},outcome:"pending",message:""};
    expect(readInvoiceRevisionReceipt(result,lease)).not.toBeNull();
    expect(restoreInvoiceRevision(durableInvoiceRevision(lease),patientId,session.username).body).toBe(lease.body);
    const altered={...lease,body:JSON.stringify({...change,lines:[{...change.lines[0],doctorId:doctor}]})};
    expect(()=>restoreInvoiceRevision(durableInvoiceRevision(altered),patientId,session.username)).toThrow();
    expect(await revision.reviseInvoice(issued.invoice.id,change,session)).toEqual({...result,replayed:true});
    expect(await q("SELECT id FROM payments WHERE patient_id=$1",[patientId])).toEqual([]);
  });
  it("keeps an unstarted whole-mouth scope singular while correcting its provider/service",async()=>{
    const {patientId,doctor,nextDoctor}=await identityFixture();
    const [service,nextService]=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic region one','cleaning',10000,TRUE,TRUE),('Synthetic region two','cleaning',10000,TRUE,TRUE) RETURNING id")).map(row=>row.id);
    const source={patientId,baseCurrency:"YER" as const,discountMinor:0,note:null,createdBy:session.username,actorRole:"admin",templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{},
      items:[{serviceId:service,category:"cleaning",doctorId:doctor,description:"Synthetic region one",quantity:1,unitPriceMinor:10000,toothCode:null,scope:"full_mouth" as const,caseId:null,sessions:null}]};
    const invalid=await linked.createLinkedInvoice({...source,items:[{...source.items[0],quantity:2}]});expect(invalid).toMatchObject({ok:false,reason:"shape_mismatch"});
    const issued=await linked.createLinkedInvoice(source);if(!issued.ok)throw new Error("Fixture region");
    const input=await command(issued.invoice.id,10000);
    const result=await revision.reviseInvoice(issued.invoice.id,{...input,lines:[{...input.lines[0],serviceId:nextService,doctorId:nextDoctor,toothCode:null,surfaces:null}]},session);
    expect(result).toMatchObject({corrected:{items:[{serviceId:nextService,doctorId:nextDoctor,toothCode:null}]}});
    expect(await q("SELECT site FROM clinical_cases WHERE id=$1",[issued.links[0].caseId])).toEqual([{site:"كامل الفم"}]);
  });
  it.each(["assessment","payment","commission","overlap","problem-link","referral","dependency","case-outcome"])("refuses %s identity changes atomically, preserving all evidence",async mode=>{
    const {patientId,nextDoctor,nextService,issued}=await identityFixture();
    if(mode==="assessment")await q("UPDATE clinical_cases SET problem='Synthetic saved assessment' WHERE id=$1",[issued.links[0].caseId]);
    if(mode==="payment")await db.recordPayment({patientId,invoiceId:issued.invoice.id,kind:"payment",amountMinor:1000,currency:"YER",baseCurrency:"YER",exchangeRate:1,method:"cash",note:null,createdBy:session.username,idempotencyKey:`identity-paid-${++serial}`});
    if(mode==="commission")await q("INSERT INTO commission_case_overrides(doctor_id,case_id,percent,reason,effective_from,created_by) VALUES($1,$2,20,'Synthetic preserved commission',CURRENT_DATE,'test')",[issued.invoice.items[0].doctorId,issued.links[0].caseId]);
    if(mode==="overlap")await q("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor) VALUES($1,$2,'Synthetic overlapping work','rct',46,1,10000)",[issued.planId,nextService]);
    if(mode==="problem-link")await q("INSERT INTO patient_problems(patient_id,label,case_id,plan_item_id,noted_by) VALUES($1,'Synthetic saved problem',$2,$3,'test')",[patientId,issued.links[0].caseId,issued.links[0].planItemId]);
    if(mode==="referral")await q("INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,created_by,case_id) VALUES($1,'Synthetic receiver','other','Synthetic referral','test',$2)",[patientId,issued.links[0].caseId]);
    if(mode==="case-outcome")await q("UPDATE clinical_cases SET outcome='Synthetic saved outcome' WHERE id=$1",[issued.links[0].caseId]);
    if(mode==="dependency"){
      const [other]=await q("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor) VALUES($1,$2,'Synthetic prerequisite','rct',16,1,10000) RETURNING id",[issued.planId,nextService]);
      await q("INSERT INTO plan_item_dependencies(item_id,requires_item_id,created_by) VALUES($1,$2,'test')",[other.id,issued.links[0].planItemId]);
    }
    const input=await command(issued.invoice.id,12000),before=await q("SELECT to_jsonb(i) AS value FROM plan_items i WHERE plan_id=$1 ORDER BY id",[issued.planId]);
    await expect(revision.reviseInvoice(issued.invoice.id,{...input,lines:[{...input.lines[0],serviceId:nextService,doctorId:nextDoctor,toothCode:46,surfaces:null}]},session)).rejects.toMatchObject({code:"conflict"});
    expect(await q("SELECT to_jsonb(i) AS value FROM plan_items i WHERE plan_id=$1 ORDER BY id",[issued.planId])).toEqual(before);
    expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[patientId])).toEqual([]);
    expect((await db.getInvoice(issued.invoice.id))?.status).toBe("open");
  });
});
it.each([false,true])("currency correction preserves clinical identity; shared plan=%s is explicitly refused",async shared=>{
  const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic clinical currency') RETURNING id",[`CURRENCY-CLINICAL-${++serial}`]))[0].id;
  const serviceId=(await q("INSERT INTO services(name,category,price_minor,is_active) VALUES('Synthetic currency root treatment','rct',2500,TRUE) RETURNING id"))[0].id;
  const doctorId=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic currency treating doctor','doctor') RETURNING id"))[0].id;
  const issued=await linked.createLinkedInvoice({patientId,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,actorRole:"admin",items:[{serviceId,category:"rct",doctorId,description:"Synthetic currency root treatment",quantity:1,unitPriceMinor:2500,toothCode:36,caseId:null,sessions:null}],templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{}});
  if(!issued.ok)throw new Error("Clinical currency fixture");
  const item=issued.links[0].planItemId!,caseId=issued.links[0].caseId!;
  await q("UPDATE clinical_cases SET problem='Synthetic clinical history remains unchanged' WHERE id=$1",[caseId]);
  if(shared)await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor,status) VALUES($1,'Synthetic unrelated priced treatment',1,1000,'planned')",[issued.planId]);
  const cash=await db.recordPayment({patientId,invoiceId:issued.invoice.id,kind:"payment",amountMinor:10000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-clinical-payment-${serial}`});expect(cash.reason).toBeNull();
  const cases=await q("SELECT to_jsonb(c) AS value FROM clinical_cases c WHERE patient_id=$1",[patientId]);
  const before=await revision.readInvoiceRevision(issued.invoice.id,session);
  const request={idempotencyKey:`currency-clinical-correction-${serial}`,expectedSourceHash:before.sourceHash,currency:"SAR",reason:"Synthetic documented currency correction",lines:[{itemId:issued.invoice.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:terms(240000),expectedRemainingMinor:240000};
  if(shared){expect(before.currencyCorrection).toMatchObject({available:false});await expect(revision.reviseInvoice(issued.invoice.id,request,session)).rejects.toThrow(/الخطة مشتركة/);expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[patientId])).toHaveLength(0);}
  else{const result=await revision.reviseInvoice(issued.invoice.id,request,session);expect(result).toMatchObject({settledMinor:10000,remainingMinor:240000});
    expect(await q("SELECT id,base_currency,total_minor::text FROM treatment_plans WHERE patient_id=$1",[patientId])).toEqual([{id:issued.planId,base_currency:"SAR",total_minor:"250000"}]);
    expect(await q("SELECT id,quantity,case_id FROM plan_items WHERE plan_id=$1",[issued.planId])).toEqual([{id:item,quantity:1,case_id:caseId}]);
    expect((await db.getInvoice((result as {corrected:{id:number}}).corrected.id))?.items[0]).toMatchObject({planItemId:item,caseId,financialReviewRequired:false});
  }
  expect(await q("SELECT to_jsonb(c) AS value FROM clinical_cases c WHERE patient_id=$1",[patientId])).toEqual(cases);
});

it.each(["visit_procedure", "synthetic_external", null] as const)(
  "unsupported source %s remains guarded across successive same-currency replacements",
  async sourceType => {
    const invoice = await fixture();
    const payment = await db.recordPayment({patientId:invoice.patientId,invoiceId:invoice.id,
      kind:"payment",amountMinor:1000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,
      method:"cash",note:null,createdBy:session.username,idempotencyKey:`source-family-payment-${++serial}`});
    expect(payment.reason).toBeNull();
    await q("UPDATE invoice_items SET source_type=$2,source_id=$3 WHERE invoice_id=$1",
      [invoice.id, sourceType, 900000 + serial]);
    let currentId = invoice.id;
    for (const amount of [12000, 14000]) {
      const result = await revision.reviseInvoice(currentId, await command(currentId, amount), session);
      currentId = (result as {corrected:{id:number}}).corrected.id;
      // Source uniqueness belongs to the original line; corrections must not copy it.
      expect(await q("SELECT source_type,source_id FROM invoice_items WHERE invoice_id=$1",[currentId]))
        .toEqual([{source_type:null,source_id:null}]);
      const view = await revision.readInvoiceRevision(currentId,session);
      expect(view.currencyCorrection).toMatchObject({available:false,reasonCodes:["INDEPENDENT_ITEM_SOURCE"]});
      const beforeInvoices = await q("SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id=$1 ORDER BY id",[invoice.patientId]);
      const beforePayments = await q("SELECT to_jsonb(p) AS row FROM payments p WHERE patient_id=$1 ORDER BY id",[invoice.patientId]);
      const beforeCorrections = await q("SELECT to_jsonb(c) AS row FROM invoice_corrections c WHERE patient_id=$1 ORDER BY id",[invoice.patientId]);
      const remaining = amount - 1000;
      const attempt = revision.reviseInvoice(currentId,{
        idempotencyKey:`source-family-currency-${++serial}`,expectedSourceHash:view.sourceHash,
        currency:"SAR",reason:"Synthetic unsupported lineage must remain blocked",
        lines:view.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:toInputAmount(amount,"SAR")})),
        discount:"0",repaymentTerms:terms(remaining),expectedRemainingMinor:remaining,
      },session);
      await expect(attempt).rejects.toMatchObject({code:"conflict",reasonCodes:["INDEPENDENT_ITEM_SOURCE"]});
      expect(await q("SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).toEqual(beforeInvoices);
      expect(await q("SELECT to_jsonb(p) AS row FROM payments p WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).toEqual(beforePayments);
      expect(await q("SELECT to_jsonb(c) AS row FROM invoice_corrections c WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).toEqual(beforeCorrections);
      expect(await q("SELECT id FROM invoice_settlement_reclassifications WHERE patient_id=$1",[invoice.patientId])).toEqual([]);
    }
  },
);

describe("six-direction currency correction of an unpaid, standalone invoice", () => {
  const directions = (["YER","SAR","USD"] as const).flatMap(from => (["YER","SAR","USD"] as const)
    .filter(to => to !== from && !(from === "YER" && to === "SAR")).map(to => ({ from, to })));
  // Explicit target amounts typed by the owner; never an exchange-rate conversion.
  const target = { YER: "45000", SAR: "300", USD: "80" } as const;
  async function currencyCommand(invoiceId: number, to: Currency) {
    const view = await revision.readInvoiceRevision(invoiceId,session);
    const minor = target[to] === "45000" ? 45000 : Number(target[to]) * 100;
    return { minor, input: { idempotencyKey:`unpaid-currency-${++serial}`,expectedSourceHash:view.sourceHash,currency:to,
      reason:"Invoice was issued in the wrong currency before any payment",
      lines:view.invoice.items.map(item=>({itemId:item.id,quantity:item.quantity,unitPrice:target[to]})),
      discount:"0",discountReason:null,repaymentTerms:terms(minor),expectedRemainingMinor:minor } };
  }
  it.each(directions)("$from -> $to replaces the unpaid invoice once, moves the debt to the target currency only, and replays", async ({from,to}) => {
    const invoice = await fixture(0,from);
    const cashBefore = (await db.getOpenShift())!.expected;
    const view = await revision.readInvoiceRevision(invoice.id,session);
    expect(view.currencyCorrection).toMatchObject({available:true,targets:expect.arrayContaining([to])});
    const {minor,input} = await currencyCommand(invoice.id,to);
    const saved = await revision.reviseInvoice(invoice.id,input,session);
    expect(saved).toMatchObject({currency:to,originalCurrency:from,settledMinor:0,remainingMinor:minor,replayed:false});
    expect(await revision.reviseInvoice(invoice.id,input,session)).toMatchObject({replayed:true,currency:to});
    const rows = await q("SELECT id,base_currency,status,total_minor::int FROM invoices WHERE patient_id=$1 ORDER BY id",[invoice.patientId]);
    expect(rows).toEqual([{id:invoice.id,base_currency:from,status:"cancelled",total_minor:10000},
      {id:expect.any(Number),base_currency:to,status:"open",total_minor:minor}]);
    expect(await q("SELECT source_currency,target_currency,source_invoice_ids FROM invoice_settlement_reclassifications WHERE patient_id=$1",[invoice.patientId]))
      .toEqual([{source_currency:from,target_currency:to,source_invoice_ids:[invoice.id]}]);
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[invoice.patientId])).toEqual([{n:0}]);
    expect((await db.getOpenShift())!.expected).toEqual(cashBefore);
    const ledger = await db.patientLedger(invoice.patientId);
    const balances = db.ledgerBalancesByCurrency(invoice.patientId,ledger,new Map());
    expect(balances[to]).toMatchObject({billedMinor:minor,collectedMinor:0,dueMinor:minor});
    expect(balances[from]).toMatchObject({billedMinor:0,collectedMinor:0,dueMinor:0});
    // A second currency change on the same lineage is refused, not chained.
    const corrected = rows[1].id as number;
    const again = await revision.readInvoiceRevision(corrected,session);
    expect(again.currencyCorrection?.available ?? false).toBe(false);
  });
  it("a direction other than YER -> SAR is refused once any receipt exists on the invoice lineage, and the database refuses it too", async () => {
    const invoice = await fixture(1000,"SAR");
    const view = await revision.readInvoiceRevision(invoice.id,session);
    expect(view.currencyCorrection).toMatchObject({available:false});
    const {input} = await currencyCommand(invoice.id,"YER");
    await expect(revision.reviseInvoice(invoice.id,{...input,expectedRemainingMinor:44000,repaymentTerms:terms(44000)},session)).rejects.toMatchObject({code:"conflict"});
    expect(await q("SELECT id,status FROM invoices WHERE patient_id=$1",[invoice.patientId])).toEqual([{id:invoice.id,status:"open"}]);
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[invoice.id]);
      const replacement = (await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,45000,'YER','synthetic') RETURNING id",[`SIX-DB-${++serial}`,invoice.patientId])).rows[0].id;
      const correction = (await client.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
        VALUES($1,'YER','SAR',$2,$3,$4,$5,'Synthetic direct database attempt','synthetic') RETURNING id`,[invoice.patientId,invoice.id,replacement,`six-db-${serial}`,"b".repeat(64)])).rows[0].id;
      await expect(client.query("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'SAR','YER',$3)",
        [correction,invoice.patientId,[invoice.id]])).rejects.toThrow(/receipt/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("an unpaid SAR -> USD correction restores identically through the real backup path", async () => {
    const invoice = await fixture(0,"SAR");
    const {input} = await currencyCommand(invoice.id,"USD");
    await revision.reviseInvoice(invoice.id,input,session);
    const evidence = async (run: (sql: string, values?: unknown[]) => Promise<{rows: unknown[]}>) => (await run(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM invoice_corrections c WHERE patient_id=$1) AS corrections,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM invoice_settlement_reclassifications d WHERE patient_id=$1) AS documents,
      (SELECT jsonb_agg(r.receipt ORDER BY r.correction_id) FROM invoice_correction_receipts r JOIN invoice_corrections c ON c.id=r.correction_id WHERE c.patient_id=$1) AS receipts`,[invoice.patientId])).rows[0];
    const expected = await evidence((sql,values)=>db.getPool().query(sql,values));
    const client = await db.getPool().connect(); const parts: string[] = [];
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); for await (const line of db.backupSnapshotSqlLines(client)) parts.push(line); await client.query("COMMIT"); }
    finally { client.release(); }
    const {openBackupTimestampFixture} = await import("./_backup-timestamp-fixture");
    const isolated = await openBackupTimestampFixture({...process.env});
    try {
      await migrate(isolated.sqlTarget,{apply:true,files:await loadMigrationFiles()});
      await isolated.sqlTarget.query(prepareBackupSql(parts.join("")).sql);
      expect(await evidence((sql,values)=>isolated.sqlTarget.query(sql,values))).toEqual(expected);
    } finally { await isolated.close(); }
  });
});
