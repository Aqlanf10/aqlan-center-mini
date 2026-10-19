import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { JournalEntry, JournalLine } from "../../lib/accounting";
import type { Currency } from "../../lib/money";

// Fail closed before stubPostgresEnv removes Railway markers or any SQL runs.
// These fixtures own only the isolated PostgreSQL 18 test database.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";
process.env.SESSION_SECRET ??= "synthetic-payroll-journal-session-secret-only";

const db = await import("../../lib/db");
const hr = await import("../../lib/hr");
const payroll = await import("../../lib/hr-payroll");
const contracts = await import("../../lib/hr-contracts-attendance");
const { sessionCredentialVersion } = await import("../../lib/auth");
const { isBalanced } = await import("../../lib/accounting");

const FROM = "0001-01-01", THROUGH = "9999-12-31";
const AT = "2026-10-12T09:00:00.000Z";
const cash: Record<Currency, string> = { YER: "1101", SAR: "1102", USD: "1103" };
let admin: SessionPayload;
let shiftId: number;
let sequence = 0;

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, values)).rows as T[];
}
async function id(sql: string, values: unknown[] = []): Promise<number> {
  return (await q<{ id: number }>(sql, values))[0].id;
}
async function journal(from = FROM, to = THROUGH) {
  const entries = await db.journalEntries(from, to);
  expect(entries.every(isBalanced)).toBe(true);
  return entries;
}
function entry(entries: JournalEntry[], reference: string) {
  const found = entries.find(value => value.reference === reference);
  expect(found, `Missing journal source ${reference}`).toBeDefined();
  return found!;
}
function line(accountCode: string, amountMinor: number, side: JournalLine["side"], currency: Currency = "YER"): JournalLine {
  return { accountCode, amountMinor, side, currency };
}
function expectLines(value: JournalEntry, expected: JournalLine[]) {
  const sort = (lines: JournalLine[]) => lines.map(item => JSON.stringify([item.accountCode, item.currency, item.side, item.amountMinor])).sort();
  expect(sort(value.lines)).toEqual(sort(expected));
  expect(isBalanced(value)).toBe(true);
}
function net(entries: JournalEntry[], accountCode: string, currency: Currency = "YER") {
  return entries.flatMap(value => value.lines)
    .filter(value => value.accountCode === accountCode && value.currency === currency)
    .reduce((total, value) => total + (value.side === "debit" ? value.amountMinor : -value.amountMinor), 0);
}
async function expenseReference(expenseId: number) {
  return (await q<{ voucher_number: string }>("SELECT voucher_number FROM expenses WHERE id=$1", [expenseId]))[0].voucher_number;
}
async function remaining(payableId: number) {
  const [value] = await q<{ remaining: string }>(
    `SELECT (${db.payableAmountSql("p")}-${db.payableSettledTotalSql("p")})::text AS remaining FROM payables p WHERE id=$1`,
    [payableId]);
  return Number(value.remaining);
}

beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const [actor] = await q<{ id: number; password_hash: string }>(
    `INSERT INTO users(username,display_name,password_hash,role)
     VALUES('payroll-journal-admin','Synthetic journal administrator','synthetic-journal-hash','admin') RETURNING id,password_hash`);
  admin = { userId: actor.id, username: "payroll-journal-admin", role: "admin", expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion(actor.password_hash) };
  expect(await db.findUserByUsername(admin.username)).toMatchObject({ id: actor.id, role: "admin", isActive: true });
  shiftId = await id("INSERT INTO cashier_shifts(opened_by) VALUES($1) RETURNING id", [admin.username]);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function staff(kind: "salary" | "salary_commission", salary = 100) {
  const fullName = `Synthetic payroll journal staff ${++sequence}`;
  const created = await hr.createStaff({ fullName, phone: null, department: kind === "salary" ? "secretariat" : "doctors",
    jobTitle: "Synthetic journal fixture", hireDate: "2025-01-01", workStatus: "active", endDate: null,
    contractKind: kind, payTerms: { amountMinor: salary, currency: "YER", period: "monthly", effectiveOn: "2025-01-01" }, note: null }, admin);
  return created.id;
}
async function approve(staffId: number) {
  const period = await payroll.getOrCreatePayrollPeriod("2026-10", admin);
  const run = await payroll.calculatePayrollRun(period.id, "YER", admin);
  await payroll.approvePayrollRun(run.id, admin);
  const item = (await payroll.listPayrollItems(run.id)).find(value => value.staffId === staffId)!;
  expect(item.payableId).not.toBeNull();
  return { run, item };
}
async function earnCommission(partyId: number) {
  const suffix = ++sequence;
  const patientId = await id("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic journal patient') RETURNING id", [`JRN-P-${suffix}`]);
  const invoiceId = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES($1,$2,400,0,'YER','synthetic',$3) RETURNING id`, [`JRN-I-${suffix}`, patientId, AT]);
  await q(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id)
    VALUES($1,'Synthetic commission service',1,400,400,$2)`, [invoiceId, partyId]);
  await q(`INSERT INTO visits(patient_name,patient_id,doctor_id,status,invoice_id,arrived_at,signed_at,signed_by)
    VALUES('Synthetic journal patient',$1,$2,'done',$3,$4,$4,'synthetic')`, [patientId, partyId, invoiceId, AT]);
  await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,
    base_amount_minor,base_currency,method,created_by,created_at)
    VALUES($1,$2,$3,$4,'payment',400,'YER',1,400,'YER','cash','synthetic',$5)`, [`JRN-R-${suffix}`, patientId, invoiceId, shiftId, AT]);
}

describe("payroll disbursement journals use their actual payable links", () => {
  it("accrues 100 once, settles 40 then 60, reverses 60 and replays without duplicate expense or cash", async () => {
    const { run, item } = await approve(await staff("salary"));
    let entries = await journal();
    expectLines(entry(entries, `PB-${item.payableId}`), [line("5401", 100, "debit"), line("2101", 100, "credit")]);
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "2101")).toBe(-100);
    expect(net(entries, cash.YER)).toBe(0);

    const first = await payroll.disbursePayrollItem(item.id, { amountMinor: 40, clientRequestId: "journal-salary-40" }, admin);
    entries = await journal();
    expectLines(entry(entries, await expenseReference(first.parts[0].expenseId)), [line("2101", 40, "debit"), line(cash.YER, 40, "credit")]);
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "2101")).toBe(-60);
    expect(net(entries, cash.YER)).toBe(-40);
    expect(await remaining(item.payableId!)).toBe(60);

    const second = await payroll.disbursePayrollItem(item.id, { amountMinor: 60, clientRequestId: "journal-salary-60" }, admin);
    entries = await journal();
    const original = entry(entries, await expenseReference(second.parts[0].expenseId));
    expectLines(original, [line("2101", 60, "debit"), line(cash.YER, 60, "credit")]);
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "2101")).toBe(0);
    expect(net(entries, cash.YER)).toBe(-100);
    expect(await remaining(item.payableId!)).toBe(0);

    await payroll.reversePayrollDisbursement(second.id, { reason: "Synthetic journal reversal" }, admin);
    const [reversal] = await q<{ id: number; voucher_number: string }>("SELECT id,voucher_number FROM expenses WHERE reversal_of_id=$1", [second.parts[0].expenseId]);
    entries = await journal();
    expect(entry(entries, reversal.voucher_number).source).toBe("expense_void");
    expectLines(entry(entries, reversal.voucher_number), [line("2101", 60, "credit"), line(cash.YER, 60, "debit")]);
    expect(entry(entries, original.reference)).toEqual(original);
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "2101")).toBe(-60);
    expect(net(entries, cash.YER)).toBe(-40);
    expect(await remaining(item.payableId!)).toBe(60);
    expect((await payroll.listPayrollItems(run.id))[0]).toMatchObject({ paidMinor: 40, remainingMinor: 60 });

    const beforeReplay = entries;
    const replay = await payroll.disbursePayrollItem(item.id, { amountMinor: 60, clientRequestId: "journal-salary-60" }, admin);
    expect(replay).toMatchObject({ id: second.id, replayed: true });
    await payroll.reversePayrollDisbursement(second.id, { reason: "Synthetic journal reversal" }, admin);
    expect(await journal()).toEqual(beforeReplay);
    expect(await q("SELECT id FROM expenses")).toHaveLength(3);
    await payroll.disbursePayrollItem(item.id, { amountMinor: 60, clientRequestId: "journal-salary-60-new" }, admin);
    entries = await journal();
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "2101")).toBe(0);
    expect(net(entries, cash.YER)).toBe(-100);
    expect(await remaining(item.payableId!)).toBe(0);
  });

  it("settles both doctor salary and commission, without recording either cost twice", async () => {
    const staffId = await staff("salary_commission");
    const doctor = await db.createParty({ name: `Synthetic journal doctor ${++sequence}`, kind: "doctor", phone: null, commissionPercent: 30, note: null });
    const contract = await contracts.createContract({ staffId, templateKind: "doctor_hybrid", title: "Synthetic journal contract",
      startDate: "2025-01-01", compensationKind: "salary_commission", baseSalaryMinor: 100,
      salaryCurrency: "YER", salaryPeriod: "monthly", commissionRatePercent: 30, doctorPartyId: doctor.id }, admin);
    await contracts.approveContract(contract.id, admin);
    await contracts.transitionContractStatus(contract.id, "active", "Synthetic journal activation", admin);
    await earnCommission(doctor.id);
    const { item } = await approve(staffId);
    expect(item.commissionsMinor).toBe(120);
    const paid = await payroll.disbursePayrollItem(item.id, { amountMinor: 220, clientRequestId: "journal-doctor-full" }, admin);
    expect(paid.parts.map(part => [part.component, part.amountMinor]).sort()).toEqual([["commission", 120], ["salary", 100]]);
    const entries = await journal();
    expectLines(entry(entries, `PB-${item.payableId}`), [line("5401", 100, "debit"), line("2101", 100, "credit")]);
    expectLines(entry(entries, `PB-${item.commissionPayableId}`), [line("5301", 120, "debit"), line("2101", 120, "credit")]);
    for (const part of paid.parts) {
      expectLines(entry(entries, await expenseReference(part.expenseId)), [line("2101", part.amountMinor, "debit"), line(cash.YER, part.amountMinor, "credit")]);
      expect(await remaining(part.payableId!)).toBe(0);
    }
    expect(net(entries, "5401")).toBe(100);
    expect(net(entries, "5301")).toBe(120);
    expect(net(entries, "2101")).toBe(0);
    expect(net(entries.filter(value => ["expense", "expense_void"].includes(value.source)), cash.YER)).toBe(-220);
    await payroll.reversePayrollDisbursement(paid.id, { reason: "Synthetic doctor reversal" }, admin);
    const reversed = await journal();
    expect(net(reversed, "5401")).toBe(100);
    expect(net(reversed, "5301")).toBe(120);
    expect(net(reversed, "2101")).toBe(-220);
    expect(net(reversed.filter(value => ["expense", "expense_void"].includes(value.source)), cash.YER)).toBe(0);
  });
});

// SQL fixtures model historical document shapes that current writers need not
// produce. Inserts preserve append-only guards; no financial row is rewritten.
async function party(kind = "employee", account: string | null = null, expenseAccount: string | null = null, posted = true) {
  return id(`INSERT INTO parties(name,kind,payable_account_code,expense_account_code,auto_post_journal)
    VALUES($1,$2,$3,$4,$5) RETURNING id`, [`Synthetic journal party ${++sequence}`, kind, account, expenseAccount, posted]);
}
async function payable(partyId: number, options: {
  amount?: number; currency?: Currency; rate?: number; account?: string | null; at?: string; posted?: boolean; source?: "operational" | "opening";
} = {}) {
  const amount = options.amount ?? 100, currency = options.currency ?? "YER", rate = options.rate ?? 1;
  return id(`INSERT INTO payables(party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,
    base_currency,payable_account_code,created_at,is_posted,source_type,as_of_date,opening_reason)
    VALUES($1,'salary','Synthetic journal payable',$2,$3,$4,$5,'YER',$6,$7,$8,$9,$10,'Synthetic opening journal fixture') RETURNING id`,
  [partyId, amount, currency, rate, Math.round(amount * rate / (currency === "YER" ? 1 : 100)), options.account ?? null, options.at ?? AT, options.posted ?? true, options.source ?? "operational", options.source === "opening" ? "2026-01-01" : null]);
}
async function expense(partyId: number | null, options: {
  amount?: number; currency?: Currency; rate?: number; base?: number; payableId?: number | null;
  snapshotCurrency?: Currency | null; settled?: number | null; category?: string; at?: string; reversalOf?: number | null;
} = {}) {
  const amount = options.amount ?? 100, currency = options.currency ?? "YER", rate = options.rate ?? 1;
  const reference = `JRN-E-${++sequence}`;
  const expenseId = await id(`INSERT INTO expenses(voucher_number,category,party_id,payee_text,shift_id,amount_minor,currency,
    exchange_rate,base_amount_minor,base_currency,payable_id,payable_currency,payable_settled_minor,created_at,created_by,reversal_of_id)
    VALUES($1,$2,$3,'Synthetic journal payee',$4,$5,$6,$7,$8,'YER',$9,$10,$11,$12,'synthetic',$13) RETURNING id`,
  [reference, options.category ?? "salary", partyId, shiftId, amount, currency, rate,
    options.base ?? Math.round(amount * rate / (currency === "YER" ? 1 : 100)), options.payableId ?? null,
    options.snapshotCurrency ?? null, options.settled ?? null, options.at ?? AT, options.reversalOf ?? null]);
  return { id: expenseId, reference };
}
async function allocation(expenseId: number, payableId: number, paid: number, settled = paid, currency: Currency = "YER") {
  await q(`INSERT INTO expense_payable_allocations(expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor)
    VALUES($1,$2,$3,$4,1,$5)`, [expenseId, payableId, paid, currency, settled]);
}

describe("journal settlement projection preserves other document semantics", () => {
  it("keeps unlinked employee/doctor expenses and unlinked lab/supplier advances", async () => {
    for (const kind of ["employee", "doctor", "lab", "supplier"]) {
      const partyId = await party(kind, "2107", "5402");
      const voucher = await expense(partyId);
      expectLines(entry(await journal(), voucher.reference), [line(["lab", "supplier"].includes(kind) ? "2107" : "5402", 100, "debit"), line(cash.YER, 100, "credit")]);
    }
    const voucher = await expense(null);
    expectLines(entry(await journal(), voucher.reference), [line("5401", 100, "debit"), line(cash.YER, 100, "credit")]);
  });

  it("uses a direct payable's account before its party account for YER, SAR and USD", async () => {
    for (const currency of ["YER", "SAR", "USD"] as const) {
      const partyId = await party("employee", "2101");
      const payableId = await payable(partyId, { currency, account: "2107" });
      const voucher = await expense(partyId, { currency, payableId, snapshotCurrency: currency, settled: 100 });
      const entries = await journal();
      expectLines(entry(entries, `PB-${payableId}`), [line("5401", 100, "debit", currency), line("2107", 100, "credit", currency)]);
      expectLines(entry(entries, voucher.reference), [line("2107", 100, "debit", currency), line(cash[currency], 100, "credit", currency)]);
      expect(await remaining(payableId)).toBe(0);
    }
  });

  it("keeps allocation accounts separate and places only the remainder on the party account, including reversal", async () => {
    const partyId = await party("employee", "2101");
    const first = await payable(partyId, { amount: 40, account: "2107" });
    const second = await payable(partyId, { amount: 50, account: "2106" });
    const voucher = await expense(partyId);
    await allocation(voucher.id, first, 40);
    await allocation(voucher.id, second, 50);
    const expected = [line("2107", 40, "debit"), line("2106", 50, "debit"), line("2101", 10, "debit"), line(cash.YER, 100, "credit")];
    expectLines(entry(await journal(), voucher.reference), expected);
    const reversal = await expense(partyId, { amount: -100, reversalOf: voucher.id });
    await allocation(reversal.id, first, -40);
    await allocation(reversal.id, second, -50);
    const entries = await journal();
    expectLines(entry(entries, reversal.reference), expected.map(value => ({ ...value, side: value.side === "debit" ? "credit" : "debit" })));
    expect(net(entries.filter(value => ["expense", "expense_void"].includes(value.source)), "2107")).toBe(0);
    expect(net(entries.filter(value => ["expense", "expense_void"].includes(value.source)), "2106")).toBe(0);
    expect(net(entries.filter(value => ["expense", "expense_void"].includes(value.source)), cash.YER)).toBe(0);
  });

  it("settles lab/supplier opening debts and batch allocations without turning opening equity into expense", async () => {
    for (const kind of ["lab", "supplier"]) {
      const partyId = await party(kind, "2101");
      const payableId = await payable(partyId, { source: "opening", account: "2105" });
      const direct = await expense(partyId, { amount: 40, payableId });
      const batch = await expense(partyId, { amount: 60 });
      await allocation(batch.id, payableId, 60);
      const entries = await journal();
      expect(entries.some(value => value.reference === `PB-${payableId}`)).toBe(false);
      expect(entry(entries, `OP-${payableId}`).source).toBe("opening_payable");
      expectLines(entry(entries, `OP-${payableId}`), [line("3101", 100, "debit"), line("2105", 100, "credit")]);
      expectLines(entry(entries, direct.reference), [line("2105", 40, "debit"), line(cash.YER, 40, "credit")]);
      expectLines(entry(entries, batch.reference), [line("2105", 60, "debit"), line(cash.YER, 60, "credit")]);
      expect(await remaining(payableId)).toBe(0);
      expect(net(entries, "5401")).toBe(0);
    }
  });

  it("uses recorded direct/allocation FX amounts and does not revalue them at current settings", async () => {
    const partyId = await party("doctor", "2101");
    const direct = await payable(partyId, { currency: "USD", amount: 1_000, rate: 530, account: "2106" });
    const voucher = await expense(partyId, { amount: 700, payableId: direct, snapshotCurrency: "USD", settled: 125 });
    const allocated = await payable(partyId, { currency: "SAR", amount: 1_000, rate: 140, account: "2107" });
    const batch = await expense(partyId, { amount: 300 });
    await allocation(batch.id, allocated, 300, 225, "SAR");
    const entries = await journal();
    expectLines(entry(entries, voucher.reference), [line("1901", 700, "debit"), line("1901", 125, "credit", "USD"), line("2106", 125, "debit", "USD"), line(cash.YER, 700, "credit")]);
    expectLines(entry(entries, batch.reference), [line("1901", 300, "debit"), line("1901", 225, "credit", "SAR"), line("2107", 225, "debit", "SAR"), line(cash.YER, 300, "credit")]);
    const directReversal = await expense(partyId, { amount: -700, payableId: direct, snapshotCurrency: "USD", settled: -125, reversalOf: voucher.id });
    const batchReversal = await expense(partyId, { amount: -300, reversalOf: batch.id });
    await allocation(batchReversal.id, allocated, -300, -225, "SAR");
    const withReversals = await journal();
    for (const [original, reversal] of [[voucher, directReversal], [batch, batchReversal]]) {
      expectLines(entry(withReversals, reversal.reference), entry(entries, original.reference).lines
        .map(value => ({ ...value, side: value.side === "debit" ? "credit" : "debit" })));
    }
    await q(`INSERT INTO settings(key,value) VALUES('finance.rate.USD','999'),('finance.rate.SAR','333')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    expect(await journal()).toEqual(withReversals);
  });

  it("retains all legacy settledOnPayableSql branches, including round-to-zero", async () => {
    const cases: Array<{ paidCurrency: Currency; payableCurrency: Currency; amount: number; base: number; rate: number; settled: number }> = [
      { paidCurrency: "USD", payableCurrency: "USD", amount: 125, base: 663, rate: 530, settled: 125 },
      { paidCurrency: "USD", payableCurrency: "YER", amount: 125, base: 663, rate: 1, settled: 663 },
      { paidCurrency: "SAR", payableCurrency: "USD", amount: 100, base: 140, rate: 530, settled: 26 },
      { paidCurrency: "YER", payableCurrency: "USD", amount: 1, base: 1, rate: 530, settled: 0 },
    ];
    for (const fixture of cases) {
      const partyId = await party("employee", "2107");
      const payableId = await payable(partyId, { currency: fixture.payableCurrency, rate: fixture.rate, amount: 1_000 });
      const voucher = await expense(partyId, { currency: fixture.paidCurrency, amount: fixture.amount, base: fixture.base, payableId });
      const lines = fixture.paidCurrency === fixture.payableCurrency
        ? [line("2107", fixture.settled, "debit", fixture.payableCurrency), line(cash[fixture.paidCurrency], fixture.amount, "credit", fixture.paidCurrency)]
        : [line("1901", fixture.amount, "debit", fixture.paidCurrency), line("1901", fixture.settled, "credit", fixture.payableCurrency),
          line("2107", fixture.settled, "debit", fixture.payableCurrency), line(cash[fixture.paidCurrency], fixture.amount, "credit", fixture.paidCurrency)].filter(value => value.amountMinor !== 0);
      expectLines(entry(await journal(), voucher.reference), lines);
      expect(await remaining(payableId)).toBe(1_000 - fixture.settled);
    }
    const partyId = await party("employee", "2107");
    const payableId = await payable(partyId, { currency: "USD", rate: 530 });
    const rounded = await expense(partyId, { amount: 1 });
    await allocation(rounded.id, payableId, 1, 0, "USD");
    expectLines(entry(await journal(), rounded.reference), [line("1901", 1, "debit"), line(cash.YER, 1, "credit")]);
  });

  it("uses the voucher clinic date even when its liability accrued outside the requested period", async () => {
    const partyId = await party("employee", "2107");
    const payableId = await payable(partyId, { at: "2026-09-01T09:00:00.000Z" });
    const before = await expense(partyId, { amount: 40, payableId, at: "2026-10-10T20:59:59.999Z" });
    const after = await expense(partyId, { amount: 60, payableId, at: "2026-10-10T21:00:00.000Z" });
    const tenth = await journal("2026-10-10", "2026-10-10");
    const eleventh = await journal("2026-10-11", "2026-10-11");
    expect(tenth.map(value => value.reference)).toEqual([before.reference]);
    expect(eleventh.map(value => value.reference)).toEqual([after.reference]);
    expect(entry(eleventh, after.reference).date).toBe("2026-10-11");
    expectLines(entry(eleventh, after.reference), [line("2107", 60, "debit"), line(cash.YER, 60, "credit")]);
  });

  it("preserves party/category posting exclusions and payable is_posted behavior", async () => {
    const disabledParty = await party("employee", "2107", null, false);
    const hiddenByParty = await expense(disabledParty, { payableId: 2_000_000_000 });
    await q(`INSERT INTO expense_categories(key,name,account_code,auto_post_journal)
      VALUES('synthetic-journal-hidden','Synthetic journal hidden','5401',false)`);
    const activeParty = await party("employee", "2107");
    const hiddenByCategory = await expense(activeParty, { category: "synthetic-journal-hidden", payableId: 2_000_000_000 });
    const unposted = await payable(activeParty, { posted: false });
    const visiblePayment = await expense(activeParty, { payableId: unposted });
    const entries = await journal();
    expect(entries.some(value => [hiddenByParty.reference, hiddenByCategory.reference, `PB-${unposted}`].includes(value.reference))).toBe(false);
    expectLines(entry(entries, visiblePayment.reference), [line("2107", 100, "debit"), line(cash.YER, 100, "credit")]);
  });
});

describe("journal reads reject corrupt payable linkage rather than hide or double count it", () => {
  it.each(["missing direct", "wrong direct party", "wrong direct snapshot currency", "missing voucher party", "direct plus allocation", "wrong allocation party", "wrong allocation currency",
    "opposite paid sign", "opposite settled sign", "settled without paid", "zero allocation", "overallocated", "unresolved legacy FX"] as const)("rejects %s", async corruption => {
    const owner = await party("employee", "2107");
    const other = await party("employee", "2106");
    const payableId = await payable(owner, corruption === "unresolved legacy FX" ? { currency: "USD", rate: 0 } : {});
    let voucher: Awaited<ReturnType<typeof expense>>;
    if (corruption === "missing direct") voucher = await expense(owner, { payableId: 2_000_000_000 });
    else if (corruption === "wrong direct party") voucher = await expense(other, { payableId });
    else if (corruption === "wrong direct snapshot currency") voucher = await expense(owner, { payableId, snapshotCurrency: "USD", settled: 100 });
    else if (corruption === "missing voucher party") voucher = await expense(null, { payableId });
    else if (corruption === "unresolved legacy FX") voucher = await expense(owner, { payableId });
    else {
      voucher = await expense(corruption === "wrong allocation party" ? other : owner,
        corruption === "direct plus allocation" ? { payableId } : {});
      const paid = corruption === "opposite paid sign" ? -100 : ["settled without paid", "zero allocation"].includes(corruption) ? 0 : corruption === "overallocated" ? 101 : 100;
      const settled = corruption === "opposite settled sign" ? -100 : corruption === "zero allocation" ? 0 : 100;
      await allocation(voucher.id, payableId, paid, settled, corruption === "wrong allocation currency" ? "SAR" : "YER");
    }
    const before = await q("SELECT * FROM expenses ORDER BY id");
    await expect(db.journalEntries(FROM, THROUGH)).rejects.toThrow(`سلامة ربط تسوية سند الصرف ${voucher.reference}`);
    expect(await q("SELECT * FROM expenses ORDER BY id")).toEqual(before);
  });
});
