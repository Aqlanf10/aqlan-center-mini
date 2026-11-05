import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { parseInvoiceCommand, invoiceCommandFingerprint, invoiceCatalogRequestFingerprint } from "../../lib/invoice-template";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { LabWorkDraft } from "../../lib/lab-work-intent-contract";
const target = validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const invoiceWriter = await import("../../lib/invoice-linkage-db");
const revision = await import("../../lib/invoice-revision-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actor: SessionPayload;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const username = `synthetic-lab-commission-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab commission','synthetic-password-hash','admin') RETURNING id", [username]);
  actor = { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  await db.openShift({ openedBy: username, opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(grouped = false, withCost = true) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab cost patient') RETURNING id", [`LCC-${randomUUID()}`]);
  const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic lab cost doctor','doctor',30) RETURNING id");
  const [service] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,$2,1000,TRUE,TRUE) RETURNING id", [`Synthetic cost service ${randomUUID()}`, grouped ? "bridge" : "crown"]);
  const [lab] = await q("INSERT INTO parties(name,kind,currency) VALUES('Synthetic commission lab','lab','YER') RETURNING id");
  const intentId = randomUUID();
  const items = (grouped ? [27, 28] : [27]).map(tooth => {
    const labWork: LabWorkDraft = { intentId, memberId: randomUUID(), expectedRevision: 0, groupKind: grouped ? "bridge" : "single", prescription: { partyId: lab.id, shade: "", stumpShade: "", toothNumbers: "", dueDate: "2026-11-01", impressionType: "physical", priority: "normal" } };
    return { serviceId: service.id, doctorId: doctor.id, quantity: 1, price: "1000", sessions: 1, toothCode: tooth, episodeTeeth: [tooth], labWork };
  });
  const source = { patientId: patient.id, currency: "YER", idempotencyKey: `lcc-${randomUUID()}`, items };
  const parsed = parseInvoiceCommand(source, new Map((await db.listServices()).map(s => [s.id, s])), new Set([doctor.id]), await db.getSettings(), true);
  if (!parsed.ok) throw Error(parsed.message);
  const result = await invoiceWriter.createLinkedInvoice({ patientId: patient.id, baseCurrency: parsed.baseCurrency, discountMinor: parsed.discountMinor, note: parsed.note, existingPlanId: parsed.existingPlanId, items: parsed.items, createdBy: actor.username, actorRole: actor.role, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: source.idempotencyKey, requestHash: invoiceCatalogRequestFingerprint(source, actor), catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session: actor }, auditDetails: {} });
  if (!result.ok) throw Error(result.reason);
  const orderId = result.labWork![0].orderId;
  if (withCost) await db.updateLabOrderAccounting(orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
  return { patientId: patient.id as number, doctorId: doctor.id as number, invoice: result.invoice, orderId, intentId };
}
async function report(doctorId: number) { return (await db.commissionReport("2020-01-01", "2999-12-31")).find(row => row.doctorId === doctorId && row.currency === "YER")!; }
async function payment(f: Awaited<ReturnType<typeof fixture>>, amount: number) {
  const shift = await db.getOpenShift();
  return (await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
    VALUES($1,$2,$3,$4,'payment',$5,'YER',1,$5,'YER','cash',$6) RETURNING id`, [`LCC-R-${randomUUID()}`, f.patientId, f.invoice.id, shift!.id, amount, actor.username]))[0].id;
}

describe("exact lab invoice aliases feed commission cost once", () => {
  it("metadata-only accounting cannot create a payable for cancelled linked historical cost", async () => {
    const f = await fixture(false, false);
    await q("UPDATE lab_orders SET status='cancelled',cost_minor=200,cost_currency='YER',exchange_rate=1,base_amount_minor=200 WHERE id=$1", [f.orderId]);
    const before = await q("SELECT * FROM lab_orders WHERE id=$1", [f.orderId]);
    expect(await q("SELECT id FROM payables WHERE lab_order_id=$1", [f.orderId])).toHaveLength(0);
    await expect(db.updateLabOrderAccounting(f.orderId, { expenseAccountCode: "5101", session: actor })).rejects.toMatchObject({ code: "lab_cancelled_money_review" });
    expect(await q("SELECT * FROM lab_orders WHERE id=$1", [f.orderId])).toEqual(before);
    expect(await q("SELECT id FROM payables WHERE lab_order_id=$1", [f.orderId])).toHaveLength(0);
  });

  it("concurrent financial correction/report snapshots each charge one exact lab cost", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const f = await fixture();
      const view = await revision.readInvoiceRevision(f.invoice.id, actor);
      const correction = revision.reviseInvoice(f.invoice.id, {
        idempotencyKey: `lcc-concurrent-${randomUUID()}`, expectedSourceHash: view.sourceHash,
        reason: "Synthetic concurrent financial correction", lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: item.quantity, unitPrice: "900" })),
        discount: "0", discountReason: null, repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: 900,
      }, actor);
      const reports = Promise.all(Array.from({ length: 5 }, () => report(f.doctorId)));
      const [, observations] = await Promise.all([correction, reports]);
      for (const observed of observations) {
        expect(observed.labCostMinor).toBe(200);
        expect(observed.labCostNotDeductedCount).toBe(0);
        expect([240, 210]).toContain(observed.accruedMinor);
      }
      expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 210, labCostMinor: 200 });
      expect(await q("SELECT id FROM payables WHERE lab_order_id=$1", [f.orderId])).toHaveLength(1);
    }
  });
  it("parallel linked cancellation and first pricing cannot leave cancelled payable or duplicate debt", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const f = await fixture(false, false);
      const results = await Promise.allSettled([
        db.setLabOrderStatus(f.orderId, "cancelled", { session: actor }),
        db.updateLabOrderAccounting(f.orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, session: actor }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      const order = (await db.getLabOrderById(f.orderId))!;
      const payables = await q("SELECT id FROM payables WHERE lab_order_id=$1", [f.orderId]);
      if (order.status === "cancelled") {
        expect(order.payableId).toBeNull(); expect(order.costMinor).toBeNull(); expect(payables).toHaveLength(0);
      } else {
        expect(order.status).toBe("needed"); expect(order.costMinor).toBe(200); expect(payables).toEqual([{ id: order.payableId }]);
      }
      expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1", [f.patientId])).toHaveLength(1);
    }
  });

  it("blocks linked financial cancellation and unimplemented remake without changing payable", async () => {
    const f = await fixture();
    const before = await q("SELECT * FROM payables WHERE lab_order_id=$1", [f.orderId]);
    expect(before).toHaveLength(1);
    expect(await db.deleteLabOrder(f.orderId, { actor: actor.username, actorRole: "admin", reason: "Synthetic linked delete refusal" })).toEqual({ ok: false, reason: "source_linked" });
    await expect(db.setLabOrderStatus(f.orderId, "cancelled", { session: actor })).rejects.toMatchObject({ code: "lab_cancel_financial_review" });
    expect(await q("SELECT * FROM payables WHERE lab_order_id=$1", [f.orderId])).toEqual(before);
    expect((await db.getLabOrderById(f.orderId))?.status).toBe("needed");
    await q("UPDATE lab_orders SET status='received' WHERE id=$1", [f.orderId]);
    await expect(db.setLabOrderStatus(f.orderId, "remake", { session: actor })).rejects.toMatchObject({ code: "lab_remake_review_required" });
    expect(await q("SELECT * FROM payables WHERE lab_order_id=$1", [f.orderId])).toEqual(before);
  });

  it("deducts invoice-origin cost without a visit and reduces partial collection on exact refund", async () => {
    const f = await fixture();
    expect((await q("SELECT visit_id FROM lab_orders WHERE id=$1", [f.orderId]))[0].visit_id).toBeNull();
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200, labCostNotDeductedCount: 0 });
    const receipt = await payment(f, 500);
    expect(await report(f.doctorId)).toMatchObject({ earnedMinor: 120, labCostMinor: 200 });
    const shift = await db.getOpenShift();
    await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id)
      VALUES($1,$2,$3,$4,'refund',100,'YER',1,100,'YER','cash',$5,$6)`, [`LCC-RF-${randomUUID()}`, f.patientId, f.invoice.id, shift!.id, actor.username, receipt]);
    expect(await report(f.doctorId)).toMatchObject({ earnedMinor: 96, labCostMinor: 200 });
  });
  it("charges one grouped order once even with two invoice-item aliases", async () => {
    const f = await fixture(true);
    expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1", [f.patientId])).toHaveLength(1);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 540, labCostMinor: 200, labCostNotDeductedCount: 0 });
  });
  it("keeps cost on financial replacement aliases without counting cancelled original twice", async () => {
    const f = await fixture();
    const view = await revision.readInvoiceRevision(f.invoice.id, actor);
    await revision.reviseInvoice(f.invoice.id, { idempotencyKey: `lcc-revision-${randomUUID()}`, expectedSourceHash: view.sourceHash, reason: "Synthetic financial correction", lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: item.quantity, unitPrice: "900" })), discount: "0", discountReason: null, repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: 900 }, actor);
    expect(await q("SELECT invoice_item_id FROM lab_prescription_source_memberships WHERE intent_id=$1 AND invoice_item_id IS NOT NULL", [f.intentId])).toHaveLength(2);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 210, labCostMinor: 200, labCostNotDeductedCount: 0 });
  });
  it("reports foreign lab cost without inventing FX and excludes cancelled cost", async () => {
    const f = await fixture();
    await db.updateLabOrderAccounting(f.orderId, { costMinor: 200, costCurrency: "SAR", exchangeRate: 140, actor: actor.username, actorRole: actor.role });
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300, labCostMinor: 0, labCostNotDeductedCount: 1 });
    await q("UPDATE lab_orders SET status='cancelled' WHERE id=$1", [f.orderId]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300, labCostMinor: 0, labCostNotDeductedCount: 0 });
  });
  it("blocks legacy remake creation for linked work without duplicating order or commission", async () => {
    const f = await fixture();
    await expect(db.createLabOrderRemake(f.orderId, { remakeReason: "Synthetic remake", newDueDate: "2026-11-02", actor: actor.username, actorRole: actor.role })).rejects.toMatchObject({ code: "lab_remake_review_required" });
    expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1", [f.patientId])).toHaveLength(1);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200 });
  });
});

it("refuses ambiguous active invoice lineage and rolls back payroll calculation", async () => {
  const f = await fixture();
  // Synthetic inconsistent lineage without disabling any schema guard: two
  // active invoices carrying the exact same persisted plan member identity.
  const [other] = await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,1000,0,'YER',$3) RETURNING id", [`LCC-AMB-${randomUUID()}`, f.patientId, actor.username]);
  const [item] = await q(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,plan_item_id)
    SELECT $1,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,plan_item_id FROM invoice_items WHERE id=$2 RETURNING id`, [other.id, f.invoice.items[0].id]);
  await q(`INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,invoice_item_id,linked_by_user_id)
    SELECT intent_id,member_id,patient_id,$1,linked_by_user_id
    FROM lab_prescription_source_memberships WHERE invoice_item_id=$2`, [item.id, f.invoice.items[0].id]);
  await expect(report(f.doctorId)).rejects.toMatchObject({ code: "commission_lab_lineage_review", status: 409 });
  const payroll = await import("../../lib/hr-payroll");
  const period = await payroll.getOrCreatePayrollPeriod("2026-10", actor);
  const before = await q("SELECT id FROM payables ORDER BY id");
  await expect(payroll.calculatePayrollRun(period.id, "YER", actor)).rejects.toMatchObject({ name: "HrPayrollError", code: "commission_lab_lineage_review", status: 409 });
  expect(await q("SELECT id FROM hr_payroll_runs WHERE period_id=$1", [period.id])).toHaveLength(0);
  expect(await q("SELECT id FROM payables ORDER BY id")).toEqual(before);
});
