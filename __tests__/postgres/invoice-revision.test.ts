import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { INVOICE_CORRECTION_SQL } from "../../lib/invoice-correction-schema";
import { durableInvoiceRevision, readInvoiceRevisionReceipt, readInvoiceRevisionView, restoreInvoiceRevision, type InvoiceRevisionCommand } from "../../lib/invoice-revision-view";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv, createIsolatedDatabase, adminClient } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import { toInputAmount, type Currency } from "../../lib/money";
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
const terms = (amount: number) => amount > 0 ? { mode:"installments",installments:[{dueDate:"2026-11-14",kind:"installment",amountMinor:amount}] } : { mode:"full",installments:[] };
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
  it.each([0,4000,10000])("increases and decreases an invoice with %i already paid without moving receipts or duplicating debt",async paid => {
    for (const after of [6000,14000]) {
      const invoice = await fixture(paid);
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
      try { expect(await debt.readDebtPosition(client,{patientId:invoice.patientId,currency:"YER",invoiceId:corrected,openingCurrency:null}))
        .toMatchObject({principalMinor:after,settledMinor:paid,remainingMinor:Math.max(0,after-paid)}); } finally { client.release(); }
      expect(await q("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).toEqual(receipts);
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1 AND status<>'cancelled'",[invoice.patientId])).toHaveLength(1);
      expect(await q("SELECT id FROM audit_log WHERE action='invoice.correct' AND entity_id=$1",[String(invoice.id)])).toHaveLength(1);
      const replay=await revision.reviseInvoice(invoice.id,input,session);
      expect(replay).toEqual({...result,replayed:true});
      expect(readInvoiceRevisionReceipt(replay,retained)).not.toBeNull();
      const workspace = await debt.debtRepaymentWorkspace(invoice.patientId,"2026-10-14");
      expect(workspace.targets.reduce((sum,target)=>sum+target.remainingMinor,0)).toBe(Math.max(0,after-paid));
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
      const tablesToClear=(await restored.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>'"'+String(row.tablename).replaceAll('"','""')+'"');
      await restored.query(`TRUNCATE ${tablesToClear.join(',')} RESTART IDENTITY`);await restored.query(chunks.join(""));
      for(const [index,table] of tables.entries())expect((await restored.query(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY ${table==="invoice_correction_receipts"?"correction_id":"id"}`)).rows).toEqual(snapshots[index]);
    } finally {await restored.end();const admin=adminClient("postgres");await admin.connect();try{await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);}finally{await admin.end();}}
  },120000);
});
