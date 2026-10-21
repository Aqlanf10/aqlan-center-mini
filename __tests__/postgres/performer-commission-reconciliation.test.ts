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
async function receipt(patientId: number, invoiceId: number | null, amount: number, currency: Currency, reversalOfId: number | null = null) {
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


describe("equal-time correction lineage witness", () => {
  it.each(["invoice", "account"] as const)("preserves performer allocation across two same-value corrections with %s collection", async (target) => {
    const revision = await import("../../lib/invoice-revision-db");
    const { toInputAmount } = await import("../../lib/money");
    const a = await doctor(30), b = await doctor(40), p = await patient();
    const original = await invoice(p, a.id, "YER");
    const other = await invoice(p, b.id, "YER");
    await receipt(p, target === "invoice" ? original : null, 4000, "YER");
    const cash = () => q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [p]);
    const financial = async () => {
      const detail = await db.commissionDetailReport(FROM, TO);
      return detail.lines.filter(line => line.patientId === p).map(line => ({ doctorId: line.doctorId,
        covered: line.invoiceCoveredMinor, accrued: line.accruedMinor, earned: line.earnedMinor,
        currency: line.currency, percent: line.percent, basis: line.basis })).sort((left, right) => left.doctorId - right.doctorId);
    };
    const initial = await financial(), initialCash = await cash();
    expect(initial).toEqual([
      { doctorId: a.id, covered: 4000, accrued: 3000, earned: 1200, currency: "YER", percent: 30, basis: "collected_cash" },
      { doctorId: b.id, covered: 0, accrued: 4000, earned: 0, currency: "YER", percent: 40, basis: "collected_cash" },
    ]);
    let current = original;
    for (let step = 0; step < 2; step++) {
      const view = await revision.readInvoiceRevision(current, admin);
      const result = await revision.reviseInvoice(current, {
        idempotencyKey: `performer-correction-${target}-${++seq}`, expectedSourceHash: view.sourceHash,
        reason: "SYNTHETIC same-value correction preserves work and cash",
        lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: item.quantity,
          unitPrice: toInputAmount(item.unitPriceMinor, "YER") })), discount: "0",
        repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: view.remainingMinor,
      }, admin);
      expect(result).toMatchObject({ beforeMinor: 10000, afterMinor: 10000, replayed: false });
      const [edge] = await q<{ corrected_invoice_id: number }>(
        "SELECT corrected_invoice_id FROM invoice_corrections WHERE original_invoice_id=$1 AND patient_id=$2", [current, p]);
      current = edge.corrected_invoice_id;
      expect(current).toBeGreaterThan(other);
      expect(await q(`SELECT i.total_minor::int AS total,i.discount_minor::int AS discount,
        i.created_at=original.created_at AS same_time,ii.doctor_id,ii.total_minor::int AS work
        FROM invoices i JOIN invoices original ON original.id=$2 JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.id=$1`, [current, original]))
        .toEqual([{ total: 10000, discount: 0, same_time: true, doctor_id: a.id, work: 10000 }]);
      expect(await cash()).toEqual(initialCash);
      expect.soft(await financial(), `allocation after correction ${step + 1}`).toEqual(initial);
    }
  });
});

describe("explicit reservation and currency-boundary ordering", () => {
  it("keeps allocatedInvoiceId reserved and starts the FIFO identity at the currency reissue", async () => {
    const revision = await import("../../lib/invoice-revision-db");
    const { toInputAmount } = await import("../../lib/money");
    const { readCurrencyReclassificationEvidence } = await import("../../lib/invoice-currency-evidence");
    const a = await doctor(30), b = await doctor(40), p = await patient();
    const yerOrigin = await invoice(p, b.id, "YER");
    const earlierSar = await invoice(p, a.id, "SAR");
    const targetSar = await invoice(p, b.id, "SAR");
    await db.setInvoiceStatus(yerOrigin, "cancelled", { actor: admin.username, actorRole: "admin" });
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      // Complete historical evidence accepted by the existing database guards.
      // No currency writer, eligibility or schema is changed by this test.
      const { rows: [payment] } = await client.query<{ id: number }>(`INSERT INTO payments
        (receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,created_at)
        SELECT $1,$2,$3,id,'payment',4000,'SAR',200,8000,'YER','cash',$4,'2026-10-10T07:00:00Z'
        FROM cashier_shifts WHERE status='open' LIMIT 1 RETURNING id`, [`PERFORMER-RESERVED-${++seq}`, p, yerOrigin, admin.username]);
      const key = `performer-reservation-${++seq}`;
      const { rows: [correction] } = await client.query<{ id: number }>(`INSERT INTO invoice_corrections
        (patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
        VALUES($1,'SAR','YER',$2,$3,$4,$5,'SYNTHETIC existing currency evidence',$6) RETURNING id`,
        [p, yerOrigin, targetSar, key, "a".repeat(64), admin.username]);
      await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)", [correction.id,
        JSON.stringify({ patientId: p, currency: "SAR", idempotencyKey: key, createdBy: admin.username,
          original: { id: yerOrigin, patientId: p, baseCurrency: "YER" },
          corrected: { id: targetSar, patientId: p, baseCurrency: "SAR" } })]);
      const { rows: [document] } = await client.query<{ id: number }>(`INSERT INTO invoice_settlement_reclassifications
        (correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER','SAR',$3) RETURNING id`,
        [correction.id, p, [yerOrigin]]);
      await client.query(`INSERT INTO invoice_settlement_reclassification_events
        (reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
        SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2`, [document.id, payment.id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(await readCurrencyReclassificationEvidence(client, p)).toMatchObject([
        { paymentId: payment.id, targetInvoiceId: targetSar, targetMinor: 4000 }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    // Ordinary linked receipt still enters the pre-existing pooled FIFO path.
    await receipt(p, earlierSar, 2000, "SAR");
    const cashBefore = await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [p]);
    const check = async (target: number) => {
      const detail = await db.commissionDetailReport(FROM, TO);
      expect(detail.lines.filter(line => line.patientId === p).map(line => ({ invoice: line.invoiceId,
        doctor: line.doctorId, covered: line.invoiceCoveredMinor, earned: line.earnedMinor })).sort((left, right) => left.invoice - right.invoice))
        .toEqual([{ invoice: earlierSar, doctor: a.id, covered: 2000, earned: 600 },
          { invoice: target, doctor: b.id, covered: 4000, earned: 1600 }]);
    };
    await check(targetSar);
    const view = await revision.readInvoiceRevision(targetSar, admin);
    await revision.reviseInvoice(targetSar, { idempotencyKey: `performer-reservation-correction-${++seq}`,
      expectedSourceHash: view.sourceHash, reason: "SYNTHETIC same-value reserved correction",
      lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: item.quantity, unitPrice: toInputAmount(item.unitPriceMinor, "SAR") })),
      discount: "0", repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: view.remainingMinor }, admin);
    const [{ corrected_invoice_id: corrected }] = await q<{ corrected_invoice_id: number }>(
      "SELECT corrected_invoice_id FROM invoice_corrections WHERE original_invoice_id=$1", [targetSar]);
    await check(corrected);
    expect(await readCurrencyReclassificationEvidence(db.getPool(), p)).toMatchObject([{ targetInvoiceId: corrected, targetMinor: 4000 }]);
    expect(await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [p])).toEqual(cashBefore);
  });
});
