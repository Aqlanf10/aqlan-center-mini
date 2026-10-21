import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";

validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SESSION_SECRET ??= "synthetic-performer-reconciliation-only";
const db = await import("../../lib/db");
const payroll = await import("../../lib/hr-payroll");
const hr = await import("../../lib/hr");
const contracts = await import("../../lib/hr-contracts-attendance");
const { sessionCredentialVersion } = await import("../../lib/auth");
const { isBalanced } = await import("../../lib/accounting");
const FROM = "2026-10-01", TO = "2026-10-31", AT = "2026-10-02T07:00:00Z";
let seq = 0;
let admin: SessionPayload;
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, values)).rows as T[];
}
async function id(sql: string, values: unknown[] = []) {
  return (await q<{ id: number }>(sql, values))[0].id;
}
const doctor = (percent: number) => db.createParty({ name: `SYNTHETIC performer ${++seq}`, kind: "doctor", phone: null, commissionPercent: percent, note: null });
const patient = () => id("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC commission patient') RETURNING id", [`PERFORMER-${++seq}`]);
async function invoice(patientId: number, doctorId: number, currency: Currency, discount = 0) {
  const invoiceId = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES($1,$2,10000,$3,$4,$5,$6) RETURNING id`, [`PERFORMER-I-${++seq}`, patientId, discount, currency, admin.username, AT]);
  await q(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id)
    VALUES($1,'SYNTHETIC performed work',1,10000,10000,$2)`, [invoiceId, doctorId]);
  return invoiceId;
}
async function receipt(patientId: number, invoiceId: number, amount: number, currency: Currency, reversalOfId: number | null = null) {
  const result = await db.recordPayment({ patientId, invoiceId: reversalOfId === null ? invoiceId : null,
    kind: reversalOfId === null ? "payment" : "refund", amountMinor: amount, currency, baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : 500, method: "cash", createdBy: admin.username,
    note: "SYNTHETIC reconciliation", reversalOfId });
  expect(result.reason).toBeNull();
  if (!result.payment) throw new Error("fixture receipt failed");
  // Stable synthetic chronology; never depend on the wall-clock test month.
  await q("UPDATE payments SET created_at=$2::timestamptz WHERE id=$1", [result.payment.id, reversalOfId === null ? "2026-10-10T07:00:00Z" : "2026-10-11T07:00:00Z"]);
  return result.payment.id;
}
const report = () => db.commissionReport(FROM, TO);

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const actorId = await id(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES('performer-admin','SYNTHETIC actor','synthetic-performer-hash','admin') RETURNING id`);
  admin = { userId: actorId, username: "performer-admin", role: "admin", expiresAt: Date.now() + 3600000,
    credentialVersion: sessionCredentialVersion("synthetic-performer-hash") };
  await id("INSERT INTO cashier_shifts(opened_by) VALUES($1) RETURNING id", [admin.username]);
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("performer commission and settlement reconciliation", () => {
  it("REGRESSION: equal issue timestamps cannot move partial cash between doctors when SQL row order changes", async () => {
    const a = await doctor(30), b = await doctor(40), p = await patient();
    const first = await invoice(p, a.id, "YER");
    await invoice(p, b.id, "YER");
    await receipt(p, first, 4000, "YER");
    // SQL GROUP BY does not promise an order. Both permutations are legitimate
    // PostgreSQL results; change only their order, never their stored values.
    const runner = db.getPool();
    for (const direction of [1, -1]) {
      const reordered = new Proxy(runner, { get(target, prop) {
        if (prop !== "query") return Reflect.get(target, prop);
        return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql.includes("AS share_minor")) result.rows.sort((left, right) => direction * (left.invoice_id - right.invoice_id));
          return result;
        };
      } });
      const rows = await db.commissionReport(FROM, TO, undefined, reordered);
      expect(rows.find(row => row.doctorId === a.id && row.currency === "YER")?.earnedMinor).toBe(1200);
      expect(rows.find(row => row.doctorId === b.id && row.currency === "YER")?.earnedMinor).toBe(0);
    }
  });

  it("signs two explicit performers into invoice lines, not the invoice creator or visit doctor", async () => {
    const a = await doctor(30), b = await doctor(40), p = await patient();
    const creator = await doctor(50);
    const creatorName = `synthetic-invoice-creator-${++seq}`;
    await db.createStaffUser({ username: creatorName, displayName: "SYNTHETIC signing doctor", passwordHash: "synthetic-creator-hash", role: "doctor", partyId: creator.id });
    const serviceId = await id(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
      VALUES('SYNTHETIC performed service','endo',10000,TRUE,TRUE) RETURNING id`);
    const visit = await db.addVisit({ patientId: p, patientName: "SYNTHETIC commission patient", patientPhone: null, note: null });
    await q("UPDATE visits SET doctor_id=$2,diagnosis='SYNTHETIC diagnosis' WHERE id=$1", [visit.id, a.id]);
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [a, b].map(d => ({
      serviceId, doctorId: d.id, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000, note: null,
    })) })).toBe(true);
    expect((await report()).filter(row => [a.id, b.id].includes(row.doctorId))).toEqual([]);
    const signed = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: creatorName, signerDoctorPartyId: creator.id });
    expect(signed).toMatchObject({ reason: null, duesMinor: 20000 });
    const invoiceId = signed.invoiceId!;
    await q("UPDATE invoices SET created_at=$2::timestamptz WHERE id=$1", [invoiceId, AT]);
    const lines = await q<{ doctor_id: number; source_id: number; performed_by: number; status: string; created_by: string }>(
      `SELECT ii.doctor_id,ii.source_id,vp.doctor_id AS performed_by,v.status,i.created_by FROM invoice_items ii
       JOIN invoices i ON i.id=ii.invoice_id JOIN visit_procedures vp ON vp.id=ii.source_id
       JOIN visits v ON v.id=vp.visit_id WHERE ii.invoice_id=$1 ORDER BY ii.id`, [invoiceId]);
    expect(lines.map(line => [line.doctor_id, line.performed_by])).toEqual([[a.id, a.id], [b.id, b.id]]);
    expect(lines.every(line => line.status === "done" && line.created_by === creatorName)).toBe(true);
    await receipt(p, invoiceId, 10000, "YER");
    const rows = await report();
    expect(rows.find(row => row.doctorId === a.id)?.earnedMinor).toBe(1500);
    expect(rows.find(row => row.doctorId === b.id)?.earnedMinor).toBe(2000);
    expect(rows.find(row => row.doctorId === creator.id)).toBeUndefined();
  });

  it("characterizes the documented gross-share discount basis, linked refunds, cancellation and separate currency buckets", async () => {
    const d = await doctor(30), p = await patient();
    const yer = await invoice(p, d.id, "YER", 2000);
    const usd = await invoice(p, d.id, "USD");
    const payment = await receipt(p, yer, 4000, "YER");
    await receipt(p, usd, 2000, "USD");
    let rows = (await report()).filter(row => row.doctorId === d.id);
    // Existing documented formula uses gross line share / invoice net.
    // This is characterization, not a new net-of-discount policy.
    expect(rows.find(row => row.currency === "YER")).toMatchObject({ accruedMinor: 3000, earnedMinor: 1500 });
    expect(rows.find(row => row.currency === "USD")).toMatchObject({ accruedMinor: 3000, earnedMinor: 600 });
    await receipt(p, yer, 2000, "YER", payment);
    rows = (await report()).filter(row => row.doctorId === d.id);
    expect(rows.find(row => row.currency === "YER")?.earnedMinor).toBe(750);
    expect(rows.find(row => row.currency === "USD")?.earnedMinor).toBe(600);
    expect(await db.setInvoiceStatus(usd, "cancelled", { actor: admin.username, actorRole: "admin" })).toMatchObject({ status: "cancelled" });
    rows = (await report()).filter(row => row.doctorId === d.id);
    expect(rows.find(row => row.currency === "USD")).toBeUndefined();
    expect(rows.find(row => row.currency === "YER")?.earnedMinor).toBe(750);
  });
});


describe("doctor report versus payroll settlement", () => {
  it("reconciles each currency to its payable and journal, rejects repeat payout and restores balance on reversal", async () => {
    const d = await doctor(30), p = await patient();
    const staff = await hr.createStaff({ fullName: `SYNTHETIC payroll performer ${++seq}`, phone: null,
      department: "doctors", jobTitle: "SYNTHETIC", hireDate: "2025-01-01", workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, note: null }, admin);
    const contract = await contracts.createContract({ staffId: staff.id, templateKind: "doctor_percentage",
      title: "SYNTHETIC commission agreement", startDate: "2025-01-01", compensationKind: "commission",
      doctorPartyId: d.id, commissionRatePercent: 30 }, admin);
    await contracts.approveContract(contract.id, admin);
    await contracts.transitionContractStatus(contract.id, "active", "SYNTHETIC activation", admin);
    const period = await payroll.getOrCreatePayrollPeriod("2026-10", admin);
    for (const currency of ["YER", "USD"] as const) {
      const invoiceId = await invoice(p, d.id, currency);
      await receipt(p, invoiceId, 4000, currency);
      const run = await payroll.calculatePayrollRun(period.id, currency, admin);
      await payroll.approvePayrollRun(run.id, admin);
      const item = (await payroll.listPayrollItems(run.id)).find(value => value.staffId === staff.id)!;
      expect(item).toMatchObject({ baseSalaryMinor: 0, commissionsMinor: 1200, remainingMinor: 1200 });
      const key = `performer-payroll-${currency}`;
      const paid = await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 1200 }, clientRequestId: key }, admin);
      expect(paid.parts).toHaveLength(1);
      expect(paid.parts[0]).toMatchObject({ component: "commission", amountMinor: 1200, payableId: item.commissionPayableId });
      expect((await report()).find(row => row.doctorId === d.id && row.currency === currency))
        .toMatchObject({ earnedMinor: 1200, paidMinor: 1200, dueMinor: 0 });
      const [settlement] = await q<{ remaining: string; voucher_number: string; currency: string; party_id: number }>(
        `SELECT (${db.payableAmountSql("p")}-${db.payableSettledTotalSql("p")})::text AS remaining,e.voucher_number,e.currency,e.party_id
         FROM payables p JOIN expenses e ON e.payable_id=p.id WHERE p.id=$1 AND e.id=$2`,
        [item.commissionPayableId, paid.parts[0].expenseId]);
      expect(settlement).toMatchObject({ remaining: "0", currency, party_id: d.id });
      const entries = await db.journalEntries(FROM, TO);
      const cashEntry = entries.find(entry => entry.reference === settlement.voucher_number)!;
      expect(isBalanced(cashEntry)).toBe(true);
      expect(cashEntry.lines).toEqual(expect.arrayContaining([
        { accountCode: "2101", currency, amountMinor: 1200, side: "debit" },
        { accountCode: currency === "YER" ? "1101" : "1103", currency, amountMinor: 1200, side: "credit" },
      ]));
      const before = await q("SELECT id FROM expenses WHERE party_id=$1", [d.id]);
      expect(await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 1200 }, clientRequestId: key }, admin))
        .toMatchObject({ id: paid.id, replayed: true });
      await expect(payroll.disbursePayrollItem(item.id,
        { components: { commissionMinor: 1200 }, clientRequestId: `${key}-duplicate` }, admin)).rejects.toThrow();
      expect(await q("SELECT id FROM expenses WHERE party_id=$1", [d.id])).toEqual(before);
      await payroll.reversePayrollDisbursement(paid.id, { reason: "SYNTHETIC reversal reconciliation" }, admin);
      expect((await report()).find(row => row.doctorId === d.id && row.currency === currency))
        .toMatchObject({ earnedMinor: 1200, paidMinor: 0, dueMinor: 1200 });
      expect((await payroll.listPayrollItems(run.id)).find(value => value.id === item.id))
        .toMatchObject({ paidMinor: 0, remainingMinor: 1200 });
    }
  });
});

describe("commission settlement currency evidence", () => {
  it("uses a saved base equivalent and refuses an unsupported foreign-to-foreign receipt", async () => {
    const d = await doctor(30), p = await patient();
    const yer = await invoice(p, d.id, "YER");
    const paid = await receipt(p, yer, 100, "USD");
    expect(await q("SELECT currency,base_currency,base_amount_minor::int AS base FROM payments WHERE id=$1", [paid]))
      .toEqual([{ currency: "USD", base_currency: "YER", base: 500 }]);
    expect((await report()).find(row => row.doctorId === d.id && row.currency === "YER"))
      .toMatchObject({ earnedMinor: 150 });
    const otherPatient = await patient();
    const sar = await invoice(otherPatient, d.id, "SAR");
    const client = await db.getPool().connect();
    await client.query("BEGIN");
    try {
      // Deliberately invalid legacy shape, isolated in a rolled-back transaction.
      // Its stored YER equivalent cannot prove a SAR settlement amount.
      await client.query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
        exchange_rate,base_amount_minor,base_currency,method,created_by,created_at)
        SELECT 'SYNTHETIC-UNPROVEN-FX',$1,$2,id,'payment',100,'USD',500,500,'YER','cash',$3,'2026-10-10T07:00:00Z'
        FROM cashier_shifts WHERE status='open' LIMIT 1`, [otherPatient, sar, admin.username]);
      await expect(db.commissionReport(FROM, TO, undefined, client))
        .rejects.toMatchObject({ name: "FinancialCurrencyIntegrityError" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
