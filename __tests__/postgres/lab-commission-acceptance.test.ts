import { createHash, randomUUID } from "node:crypto";
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
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actor: SessionPayload;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const username = `synthetic-lab-acceptance-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab commission','synthetic-password-hash','admin') RETURNING id", [username]);
  actor = { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  await db.openShift({ openedBy: username, opening: { YER: 100000, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(grouped = false, withCost = true, deductLabCost: boolean | null = null) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab cost patient') RETURNING id", [`LCC-${randomUUID()}`]);
  const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic lab cost doctor','doctor',30) RETURNING id");
  if (deductLabCost !== null) {
    // The policy is the doctor's own dated commission configuration; effective from a fixed synthetic date.
    const config = { calculationMode: "percentage", defaultPercent: 30, categoryRates: {}, fixedAmountPerVisitMinor: 0,
      deductLabCost, deductMaterialCost: false, basis: "invoiced", effectiveDate: "2020-01-01", rateHistory: [] };
    await q("INSERT INTO users(username,display_name,password_hash,role,party_id,commission_config) VALUES($1,'Synthetic policy doctor','synthetic-password-hash','doctor',$2,$3)",
      [`synthetic-policy-doctor-${randomUUID()}`, doctor.id, JSON.stringify(config)]);
  }
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
async function payment(f: Awaited<ReturnType<typeof fixture>>, amount: number) {
  const shift = await db.getOpenShift();
  await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
    VALUES($1,$2,$3,$4,'payment',$5,'YER',1,$5,'YER','cash',$6)`, [`LCA-R-${randomUUID()}`, f.patientId, f.invoice.id, shift!.id, amount, actor.username]);
}
async function report(doctorId: number) { return (await db.commissionReport("2020-01-01", "2999-12-31")).find(row => row.doctorId === doctorId && row.currency === "YER")!; }
const payables = (orderId: number) => q("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [orderId]);

/** Owner acceptance #483 6886062729 item 3: invoice 1000, lab cost 200, doctor 30%. Synthetic data only. */
describe("crown invoice → lab cost → doctor commission, with the lab-deduction policy on and off", () => {
  it("policy on: the commission base is 800 and the accrual 240; the lab payable is one row of 200", async () => {
    const f = await fixture(false, true, true);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200, labCostNotDeductedCount: 0 });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("policy off: the base is 1000 and the accrual 300; the same single lab payable of 200 remains", async () => {
    const f = await fixture(false, true, false);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300 });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("an unpriced sent order is not a payable and deducts nothing until the cost is entered once", async () => {
    const f = await fixture(false, false, true);
    expect(await payables(f.orderId)).toEqual([]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300 });
    await db.updateLabOrderAccounting(f.orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200 });
  });
});

/** Items 2 and 4: the lab cost is one payable, separate from paying it; accrual is not collection. */
describe("the lab debt and the doctor's commission are separate facts", () => {
  const pay = async (f: Awaited<ReturnType<typeof fixture>>, amount: number, key: string) => {
    const [payable] = await q("SELECT id, party_id FROM payables WHERE lab_order_id=$1", [f.orderId]);
    return db.recordExpense({ category: "lab", partyId: payable.party_id, payeeText: null, amountMinor: amount, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, payableId: payable.id, note: "Synthetic lab settlement", createdBy: actor.username, actorRole: actor.role, request: { key, hash: createHash("sha256").update(`synthetic-lab-settlement-${amount}`).digest("hex") } });
  };
  const settled = async (orderId: number) => Number((await q(
    "SELECT COALESCE(SUM(e.payable_settled_minor),0)::int AS n FROM expenses e JOIN payables p ON p.id=e.payable_id WHERE p.lab_order_id=$1", [orderId]))[0].n);

  it("paying the lab partly then fully settles the one payable; a replay adds nothing; the cost and the commission do not move", async () => {
    const f = await fixture(false, true, true);
    const key = `lab-accept-${randomUUID()}`;
    const first = await pay(f, 80, key);
    expect(first.reason).toBeNull();
    const replay = await pay(f, 80, key);
    expect(replay.expense?.id).toBe(first.expense!.id);
    expect(await settled(f.orderId)).toBe(80);
    expect((await pay(f, 120, `lab-accept-${randomUUID()}`)).reason).toBeNull();
    expect(await settled(f.orderId)).toBe(200);
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
    expect(await q("SELECT cost_minor::int AS cost, cost_currency FROM lab_orders WHERE id=$1", [f.orderId])).toEqual([{ cost: 200, cost_currency: "YER" }]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200 });
  });
  it("accrual 240 stands before any collection; collecting 500 then the other 500 earns 120 then 240, never more", async () => {
    const f = await fixture();
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, earnedMinor: 0 });
    await payment(f, 500);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, earnedMinor: 120 });
    await payment(f, 500);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, earnedMinor: 240, labCostMinor: 200 });
  });
});

/** Item 6: a case shared by two doctors under an approved participation decision (centre decision, synthetic). */
describe("a shared crown case splits the lab cost with the work, once", () => {
  it("60/40 between a 30% and a 40% doctor: the 200 lab cost is carried 120/80, accruals 144 and 128, and the lab payable stays one row", async () => {
    const participation = await import("../../lib/commission-participation-db");
    const f = await fixture();
    const [second] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic second doctor','doctor',40) RETURNING id");
    const [clinicalCase] = await q("INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'prostho', 'Synthetic shared crown', 'synthetic') RETURNING id", [f.patientId]);
    await q("UPDATE plan_items SET case_id=$1 WHERE id=$2", [clinicalCase.id, f.invoice.items[0].planItemId]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200 });
    const decided = await participation.decideCaseParticipation({ caseId: clinicalCase.id, status: "approved",
      participants: [{ doctorId: f.doctorId, shareBp: 6_000 }, { doctorId: second.id, shareBp: 4_000 }], source: "centre_decision",
      reason: "Synthetic centre decision", expectedHeadId: null, actor: { userId: actor.userId ?? null, username: actor.username, role: actor.role } });
    expect(decided.ok).toBe(true);
    const [a, b] = [await report(f.doctorId), await report(second.id)];
    // A: (600 − 120) × 30% = 144; B: (400 − 80) × 40% = 128. The cost is carried once in total, never whole on both.
    expect([a.accruedMinor, b.accruedMinor]).toEqual([144, 128]);
    expect(a.labCostMinor + b.labCostMinor).toBe(200);
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
});

/** Item 4: payroll pays the commission in the month of collection, with the lab cost already taken from the base. */
describe("payroll with a lab cost: month of collection, no rewrite of an earlier run", () => {
  it("a September crown collected 500 in October and 500 in November pays 120 then 120; September pays nothing", async () => {
    const payroll = await import("../../lib/hr-payroll"), hr = await import("../../lib/hr"), contracts = await import("../../lib/hr-contracts-attendance");
    const f = await fixture();
    const staff = await hr.createStaff({ fullName: "Synthetic lab payroll doctor", phone: null, department: "doctors", jobTitle: "SYN", hireDate: "2025-01-01",
      workStatus: "active", endDate: null, contractKind: "commission", payTerms: null, note: null }, actor);
    const contract = await contracts.createContract({ staffId: staff.id, templateKind: "doctor_percentage", title: "Synthetic commission agreement",
      startDate: "2025-01-01", compensationKind: "commission", doctorPartyId: f.doctorId, commissionRatePercent: 30 }, actor);
    await contracts.approveContract(contract.id, actor);
    await contracts.transitionContractStatus(contract.id, "active", "Synthetic activation", actor);
    await q("UPDATE invoices SET created_at='2026-09-20T07:00:00Z' WHERE id=$1", [f.invoice.id]);
    const receipt = async (amount: number, at: string) => {
      const result = await db.recordPayment({ patientId: f.patientId, invoiceId: f.invoice.id, kind: "payment", amountMinor: amount, currency: "YER", baseCurrency: "YER",
        exchangeRate: 1, method: "cash", createdBy: actor.username, note: "Synthetic late collection", reversalOfId: null });
      expect(result.reason).toBeNull();
      await q("UPDATE payments SET created_at=$2::timestamptz WHERE id=$1", [result.payment!.id, at]);
    };
    const run = async (periodKey: string) => {
      const period = await payroll.getOrCreatePayrollPeriod(periodKey, actor);
      return payroll.calculatePayrollRun(period.id, "YER", actor);
    };
    const commission = async (runId: number) => (await payroll.listPayrollItems(runId)).find(item => item.staffId === staff.id)?.commissionsMinor ?? 0;
    await receipt(500, "2026-10-10T07:00:00Z");
    await receipt(500, "2026-11-05T07:00:00Z");
    expect(await commission((await run("2026-09")).id)).toBe(0);
    const october = await run("2026-10");
    expect(await commission(october.id)).toBe(120);
    // An approved run is a commitment: November then pays only its own collection and October is not rewritten.
    await payroll.approvePayrollRun(october.id, actor);
    expect(await commission((await run("2026-11")).id)).toBe(120);
    expect(await commission(october.id)).toBe(120);
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
});

