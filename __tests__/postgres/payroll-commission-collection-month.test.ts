/** Owner decision 2026-11-11 (finance point 2): commission on money collected later belongs to the
 * payroll month of the collection, whatever the invoice's month; nothing is paid twice; an approved
 * run is never rewritten. Real PostgreSQL, synthetic data. Before the fix the payroll run read only
 * the period's own invoices, so an invoice of September collected in October entered no run. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";

validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SESSION_SECRET ??= "synthetic-payroll-collection-month-only";
const db = await import("../../lib/db");
const payroll = await import("../../lib/hr-payroll");
const hr = await import("../../lib/hr");
const contracts = await import("../../lib/hr-contracts-attendance");
const { sessionCredentialVersion } = await import("../../lib/auth");
let seq = 0;
let admin: SessionPayload;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;

/** A doctor on a commission contract, with the staff file payroll needs. */
async function doctor(percent = 30, salaryMinor: number | null = null) {
  const party = await db.createParty({ name: `SYN late doctor ${++seq}`, kind: "doctor", phone: null, commissionPercent: percent, note: null });
  const staff = await hr.createStaff({ fullName: `SYN late staff ${seq}`, phone: null, department: "doctors", jobTitle: "SYN", hireDate: "2025-01-01",
    workStatus: "active", endDate: null, contractKind: "commission", payTerms: null, note: null }, admin);
  const contract = await contracts.createContract({ staffId: staff.id, templateKind: "doctor_percentage", title: "SYN commission agreement",
    startDate: "2025-01-01", compensationKind: salaryMinor === null ? "commission" : "salary_commission", doctorPartyId: party.id, commissionRatePercent: percent,
    ...(salaryMinor === null ? {} : { baseSalaryMinor: salaryMinor, salaryCurrency: "YER", salaryPeriod: "monthly" }) }, admin);
  await contracts.approveContract(contract.id, admin);
  await contracts.transitionContractStatus(contract.id, "active", "SYN activation", admin);
  return { partyId: party.id, staffId: staff.id };
}
const patient = () => id("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN late patient') RETURNING id", [`SYN-LATE-${++seq}`]);
async function invoice(patientId: number, doctorId: number, at: string, currency: Currency = "YER", total = 10_000, discount = 0) {
  const invoiceId = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [`SYN-LATE-I-${++seq}`, patientId, total, discount, currency, admin.username, at]);
  await q(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES($1,'SYN work',1,$2,$2,$3)`, [invoiceId, total, doctorId]);
  return invoiceId;
}
async function receipt(patientId: number, invoiceId: number | null, amount: number, at: string, currency: Currency = "YER", reversalOfId: number | null = null) {
  const result = await db.recordPayment({ patientId, invoiceId: reversalOfId === null ? invoiceId : null, kind: reversalOfId === null ? "payment" : "refund",
    amountMinor: amount, currency, baseCurrency: "YER", exchangeRate: currency === "YER" ? 1 : 500, method: "cash", createdBy: admin.username,
    note: "SYN late collection", reversalOfId });
  expect(result.reason).toBeNull();
  await q("UPDATE payments SET created_at=$2::timestamptz WHERE id=$1", [result.payment!.id, at]);
  return result.payment!.id;
}
async function run(periodKey: string, currency: Currency = "YER") {
  const period = await payroll.getOrCreatePayrollPeriod(periodKey, admin);
  return payroll.calculatePayrollRun(period.id, currency, admin);
}
const itemOf = async (runId: number, staffId: number) => (await payroll.listPayrollItems(runId)).find(item => item.staffId === staffId);
const SEP = "2026-09-30T07:00:00Z", OCT = "2026-10-10T07:00:00Z", NOV = "2026-11-05T07:00:00Z";

beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const actorId = await id(`INSERT INTO users(username,display_name,password_hash,role) VALUES('syn-late-admin','SYN actor','synthetic-late-hash','admin') RETURNING id`);
  admin = { userId: actorId, username: "syn-late-admin", role: "admin", expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion("synthetic-late-hash") };
  await id("INSERT INTO cashier_shifts(opened_by) VALUES($1) RETURNING id", [admin.username]);
}, 120_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("payroll pays commission in the month of collection", () => {
  it("an invoice of September collected in October enters the October run, not September's, and is recorded as a later collection", async () => {
    const d = await doctor(), p = await patient();
    const inv = await invoice(p, d.partyId, SEP);
    await receipt(p, inv, 10_000, OCT);
    expect((await itemOf((await run("2026-09")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    const october = await run("2026-10");
    const item = await itemOf(october.id, d.staffId);
    expect(item).toMatchObject({ commissionsMinor: 3_000 });
    expect(item!.commissionDetails).toMatchObject([{ source: "commissionCumulativeDue", periodKey: "2026-10", amountMinor: 3_000,
      periodInvoicesMinor: 0, laterCollectionsAndAdjustmentsMinor: 3_000, committedElsewhereMinor: 0 }]);
  });

  it("recalculation and a later run never pay the same commission twice", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP), 10_000, OCT);
    expect((await itemOf((await run("2026-10")).id, d.staffId))?.commissionsMinor).toBe(3_000);
    const october = await run("2026-10"); // recalculated draft: the same figure, one item
    expect((await payroll.listPayrollItems(october.id)).filter(item => item.staffId === d.staffId)).toHaveLength(1);
    expect((await itemOf(october.id, d.staffId))?.commissionsMinor).toBe(3_000);
    await payroll.approvePayrollRun(october.id, admin);
    // Approved and not yet paid: November must not offer it again.
    expect((await itemOf((await run("2026-11")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    const item = (await itemOf(october.id, d.staffId))!;
    await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-pay-1" }, admin);
    expect((await itemOf((await run("2026-11")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    await expect(payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-pay-2" }, admin)).rejects.toThrow();
    expect(await q("SELECT count(*)::int AS n FROM expenses WHERE party_id=$1 AND category='commission'", [d.partyId])).toEqual([{ n: 1 }]);
  });

  it("part collections over two months are paid month by month and add up to the whole commission", async () => {
    const d = await doctor(), p = await patient();
    const inv = await invoice(p, d.partyId, SEP);
    await receipt(p, inv, 4_000, OCT);
    await receipt(p, inv, 6_000, NOV);
    const october = await run("2026-10");
    expect((await itemOf(october.id, d.staffId))?.commissionsMinor).toBe(1_200);
    await payroll.approvePayrollRun(october.id, admin);
    const november = await run("2026-11");
    expect((await itemOf(november.id, d.staffId))?.commissionsMinor).toBe(1_800);
  });

  it("a refund after an approved, paid run does not rewrite it; the next run absorbs it", async () => {
    const d = await doctor(), p = await patient();
    const inv = await invoice(p, d.partyId, SEP);
    const paid = await receipt(p, inv, 10_000, OCT);
    const october = await run("2026-10");
    await payroll.approvePayrollRun(october.id, admin);
    const item = (await itemOf(october.id, d.staffId))!;
    await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-refund-pay" }, admin);
    expect(await payroll.closePayrollPeriod("2026-10", admin)).toMatchObject({ status: "closed" });
    await receipt(p, inv, 5_000, NOV, "YER", paid);
    // October is closed history: unchanged, and cannot be recalculated.
    expect((await itemOf(october.id, d.staffId))).toMatchObject({ commissionsMinor: 3_000 });
    await expect(run("2026-10")).rejects.toThrow();
    // November: the doctor was overpaid 1,500, so nothing is due; a new 10,000 collected in November
    // earns 3,000, of which 1,500 settles the overpayment.
    expect((await itemOf((await run("2026-11")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, NOV);
    expect((await itemOf((await run("2026-11")).id, d.staffId))?.commissionsMinor).toBe(1_500);
  });

  it("only the unpaid remainder of an earlier commitment is held back: calculate, approve, part-pay, then the next month", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP), 10_000, OCT);
    const october = await run("2026-10");
    await payroll.approvePayrollRun(october.id, admin);
    const item = (await itemOf(october.id, d.staffId))!;
    expect(item).toMatchObject({ commissionsMinor: 3_000, remainingMinor: 3_000 });
    await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 1_000 }, clientRequestId: "syn-late-part-1" }, admin);
    expect(await itemOf(october.id, d.staffId)).toMatchObject({ commissionsMinor: 3_000, paidMinor: 1_000, remainingMinor: 2_000 });
    // November, nothing new: 3,000 earned, 1,000 paid, 2,000 still committed to October: nothing more is due.
    expect((await itemOf((await run("2026-11")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    // A new 10,000 collected in November earns 3,000; October's unpaid 2,000 stays October's.
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, NOV);
    const november = await run("2026-11");
    const next = (await itemOf(november.id, d.staffId))!;
    expect(next.commissionsMinor).toBe(3_000);
    expect(next.commissionDetails).toMatchObject([{ cumulativeEarnedMinor: 6_000, cumulativePaidMinor: 1_000, committedElsewhereMinor: 2_000, amountMinor: 3_000 }]);
    // October's remainder can still be paid from October, and only once.
    await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 2_000 }, clientRequestId: "syn-late-part-2" }, admin);
    await expect(payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 1 }, clientRequestId: "syn-late-part-3" }, admin)).rejects.toThrow();
    await payroll.approvePayrollRun(november.id, admin);
    await payroll.disbursePayrollItem(next.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-part-4" }, admin);
    expect((await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === d.partyId && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 6_000, paidMinor: 6_000, dueMinor: 0 });
  });

  it("a negative balance after a refund is carried to later commission and never taken from the base salary", async () => {
    const d = await doctor(30, 200_000), p = await patient();
    const inv = await invoice(p, d.partyId, SEP);
    const paid = await receipt(p, inv, 10_000, OCT);
    const october = await run("2026-10");
    expect(await itemOf(october.id, d.staffId)).toMatchObject({ baseSalaryMinor: 200_000, commissionsMinor: 3_000 });
    await payroll.approvePayrollRun(october.id, admin);
    const item = (await itemOf(october.id, d.staffId))!;
    await payroll.disbursePayrollItem(item.id, { components: { salaryMinor: 200_000, commissionMinor: 3_000 }, clientRequestId: "syn-late-neg-1" }, admin);
    await receipt(p, inv, 10_000, NOV, "YER", paid); // the whole collection is refunded: the doctor now owes 3,000
    const november = (await itemOf((await run("2026-11")).id, d.staffId))!;
    expect(november).toMatchObject({ baseSalaryMinor: 200_000, commissionsMinor: 0, remainingMinor: 200_000 });
    // The debt is still on the doctor's statement, in its own currency, for later commission to cover.
    expect((await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === d.partyId && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 0, paidMinor: 3_000, dueMinor: -3_000 });
  });

  it("two overlapping drafts approved at once commit the commission once (shared doctor lock, re-check under it)", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP), 10_000, OCT);
    const october = await run("2026-10"), november = await run("2026-11");
    // Both drafts offer the same 3,000: neither is committed yet.
    expect([(await itemOf(october.id, d.staffId))?.commissionsMinor, (await itemOf(november.id, d.staffId))?.commissionsMinor]).toEqual([3_000, 3_000]);
    const results = await Promise.allSettled([payroll.approvePayrollRun(october.id, admin), payroll.approvePayrollRun(november.id, admin)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const committed = await q<{ total: string }>(`SELECT COALESCE(SUM(c.amount_minor),0)::text AS total FROM hr_payroll_items i JOIN payables c ON c.id=i.commission_payable_id
      WHERE (i.pay_terms_snapshot->>'doctorPartyId')::bigint=$1`, [d.partyId]);
    expect(committed).toEqual([{ total: "3000" }]);
  });

  it("two approved months paid at once pay each commission once; a retry replays and a third payment is refused", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP), 10_000, OCT);
    const october = await run("2026-10");
    await payroll.approvePayrollRun(october.id, admin);
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, NOV);
    const november = await run("2026-11");
    await payroll.approvePayrollRun(november.id, admin);
    const first = (await itemOf(october.id, d.staffId))!, second = (await itemOf(november.id, d.staffId))!;
    const pay = (itemId: number, key: string) => payroll.disbursePayrollItem(itemId, { components: { commissionMinor: 3_000 }, clientRequestId: key }, admin);
    const results = await Promise.allSettled([pay(first.id, "syn-late-both-oct"), pay(second.id, "syn-late-both-nov")]);
    // A lock-order refusal of one of the two is acceptable; a retry with the same key then completes it.
    for (const [index, result] of results.entries()) if (result.status === "rejected") await pay(index === 0 ? first.id : second.id, index === 0 ? "syn-late-both-oct" : "syn-late-both-nov");
    expect(await pay(first.id, "syn-late-both-oct")).toMatchObject({ replayed: true });
    await expect(pay(first.id, "syn-late-both-extra")).rejects.toThrow();
    expect(await q("SELECT count(*)::int AS n, sum(amount_minor)::int AS total FROM expenses WHERE party_id=$1 AND category='commission'", [d.partyId])).toEqual([{ n: 2, total: 6_000 }]);
    expect((await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === d.partyId && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 6_000, paidMinor: 6_000, dueMinor: 0 });
  });

  it("each currency has its own run and bucket; the invoice discount is honoured on a late collection", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP, "USD"), 10_000, OCT, "USD");
    await receipt(p, await invoice(p, d.partyId, SEP, "YER", 10_000, 2_000), 8_000, OCT);
    expect((await itemOf((await run("2026-10", "USD")).id, d.staffId))?.commissionsMinor).toBe(3_000);
    expect((await itemOf((await run("2026-10", "YER")).id, d.staffId))?.commissionsMinor).toBe(2_400);
  });

  it("two calculations at once leave one item with the right figure", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, SEP), 10_000, OCT);
    const period = await payroll.getOrCreatePayrollPeriod("2026-10", admin);
    const results = await Promise.allSettled([payroll.calculatePayrollRun(period.id, "YER", admin), payroll.calculatePayrollRun(period.id, "YER", admin)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    const runs = await payroll.listPayrollRuns(period.id);
    expect(runs.filter(value => value.currency === "YER")).toHaveLength(1);
    const items = (await payroll.listPayrollItems(runs.find(value => value.currency === "YER")!.id)).filter(item => item.staffId === d.staffId);
    expect(items).toHaveLength(1);
    expect(items[0].commissionsMinor).toBe(3_000);
  });

  it("recalculating an older draft after a newer run is approved never pulls the newer month's later collection back", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, OCT), 10_000, OCT);
    const octoberDraft = await run("2026-10");
    expect((await itemOf(octoberDraft.id, d.staffId))?.commissionsMinor).toBe(3_000);
    // November is calculated and approved while October is still a draft: it commits everything earned so far.
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, NOV);
    const november = await run("2026-11");
    await payroll.approvePayrollRun(november.id, admin);
    const committed = (await itemOf(november.id, d.staffId))!;
    expect(committed).toMatchObject({ commissionsMinor: 6_000, remainingMinor: 6_000 });
    // One more collection lands in November, after November's approval.
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, "2026-11-08T07:00:00Z");
    // The older draft is recalculated: October's earnings are already committed by November, and
    // the new November collection is not October's. It gets nothing; the approved run is untouched.
    const october = await run("2026-10");
    expect((await itemOf(october.id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    expect(await itemOf(november.id, d.staffId)).toMatchObject({ commissionsMinor: 6_000, remainingMinor: 6_000, paidMinor: 0 });
    await expect(run("2026-11")).rejects.toThrow();
    // Retrying the recalculation gives the same figure.
    expect((await itemOf((await run("2026-10")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
    // November is paid once; the ledger then shows exactly the later collection still due, for the next run.
    await payroll.disbursePayrollItem(committed.id, { components: { commissionMinor: 6_000 }, clientRequestId: "syn-late-horizon-1" }, admin);
    await expect(payroll.disbursePayrollItem(committed.id, { components: { commissionMinor: 1 }, clientRequestId: "syn-late-horizon-2" }, admin)).rejects.toThrow();
    expect((await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === d.partyId && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 9_000, paidMinor: 6_000, dueMinor: 3_000 });
    expect((await itemOf((await run("2026-10")).id, d.staffId))?.commissionsMinor ?? 0).toBe(0);
  });

  it("an older month approved first keeps its own commission when a newer approved month receives a later collection", async () => {
    const d = await doctor(), p = await patient();
    await receipt(p, await invoice(p, d.partyId, OCT), 10_000, OCT);
    const october = await run("2026-10");
    await payroll.approvePayrollRun(october.id, admin);
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, NOV);
    const november = await run("2026-11");
    await payroll.approvePayrollRun(november.id, admin);
    await receipt(p, await invoice(p, d.partyId, NOV), 10_000, "2026-11-08T07:00:00Z");
    const oct = (await itemOf(october.id, d.staffId))!, nov = (await itemOf(november.id, d.staffId))!;
    expect([oct.commissionsMinor, nov.commissionsMinor]).toEqual([3_000, 3_000]);
    // Both approved months are paid, each once and for its own figure; the later collection stays due.
    await payroll.disbursePayrollItem(oct.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-horizon-3" }, admin);
    await payroll.disbursePayrollItem(nov.id, { components: { commissionMinor: 3_000 }, clientRequestId: "syn-late-horizon-4" }, admin);
    await expect(payroll.disbursePayrollItem(nov.id, { components: { commissionMinor: 1 }, clientRequestId: "syn-late-horizon-5" }, admin)).rejects.toThrow();
    expect((await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === d.partyId && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 9_000, paidMinor: 6_000, dueMinor: 3_000 });
  });
});

