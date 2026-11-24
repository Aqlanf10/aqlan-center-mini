import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_REPORT_VIEW } from "../lib/report-view";
import { reportCsv } from "../lib/report-export";
import type { ReportResult } from "../lib/reports-types";

const session = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => session.role ? { role: session.role, username: "SYN-REPORT" } : null }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => session.role ? { role: session.role, username: "SYN-REPORT" } : null }));
vi.mock("@/components/SettingsProvider", () => ({
  useClinicName: () => "مركز الاختبار الاصطناعي",
  useSetting: () => "",
}));

const postgresUrl = process.env.TEST_REPORT_DISBURSEMENTS_DATABASE_URL;
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("USE_LOCAL_DB", postgresUrl ? "false" : "true");
vi.stubEnv("DATABASE_URL", postgresUrl ?? "");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
const { ensureSchema, getPool, resetPoolForTesting } = await import("../lib/db");
const { GET } = await import("../app/api/reports/route");
const { default: PrintPage } = await import("../app/print/report/page");
const { default: ReportsPage } = await import("../app/reports/page");
const { ReportView } = await import("../components/reports/ReportView");
const { FilterBar } = await import("../components/reports/shared");
const { normalizeSavedReportQuery } = await import("../lib/saved-reports");
const { buildReport, parseFilters } = await import("../lib/reports");
const { loadPayeeExpenseRangeReport } = await import("../lib/daily-clinic-expense-report");

const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
const SELECTED_DAY = "2027-01-01";
const NEXT_DAY = "2027-01-02";
const LEAP_YEAR_END = "2028-12-31";
const syntheticPayee = "مؤجر الاختبار الاصطناعي";
const syntheticCategory = "إيجار اختبار اصطناعي";
const dateInside = "2026-12-31T21:00:00Z";
const standardParams = (report: string, extra: Record<string, string> = {}) => ({
  report, preset: "custom", from: SELECTED_DAY, to: NEXT_DAY, ...extra,
});
const api = async (params: Record<string, string>) => GET(new Request("https://synthetic.invalid/api/reports?" + new URLSearchParams(params)));
async function result(params: Record<string, string>) {
  const response = await api(params);
  expect(response.status).toBe(200);
  return (await response.json()).result as ReportResult;
}
const checkCards = (r: ReportResult) => Object.fromEntries(r.kpis.map(card => [card.key, card.minor]));
const official = async (params: Record<string, string>) => renderToStaticMarkup(await PrintPage({ searchParams: Promise.resolve(params) }));
const screen = (r: ReportResult) => renderToStaticMarkup(<ReportView result={r} clinicName="مركز اصطناعي"
  generated={{ at: "2027-01-02T10:00:00Z", by: "SYN-REPORT", clinicTimeZone: "Asia/Aden" }}
  printHref="/print/report" view={EMPTY_REPORT_VIEW} onViewChange={() => {}} onPatientClick={() => {}} />);

let transferId: number, unprovedManualId: number;
beforeAll(async () => {
  await ensureSchema();
  // The PGlite adapter uses the session zone for date extraction; native
  // deliberately remains UTC so predicates must actually apply Asia/Aden.
  await q(postgresUrl ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'Asia/Aden'");
  const shift = (await q("INSERT INTO cashier_shifts(opened_by) VALUES ('synthetic outflow') RETURNING id")).rows[0].id;
  const patient = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-REPORT-P','Synthetic report patient') RETURNING id")).rows[0].id;
  const supplier = (await q("INSERT INTO parties(kind,name) VALUES ('supplier','مورد اختبار اصطناعي') RETURNING id")).rows[0].id;
  await q("INSERT INTO expense_categories(key,name) VALUES ('synthetic_rent',$1),('synthetic_other','بند اصطناعي آخر')", [syntheticCategory]);
  const expense = async (reference: string, amount: number, currency: string, options: {
    category?: string; payee?: string | null; party?: number; note?: string; at?: string; reversed?: number;
  } = {}) => Number((await q(
    "INSERT INTO expenses(voucher_number,shift_id,category,party_id,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_at,note,reversal_of_id) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$6,$7,$8::timestamptz,$9,$10) RETURNING id",
    [reference, shift, options.category ?? "synthetic_rent", options.party ?? null, options.payee ?? null,
      amount, currency, options.at ?? dateInside, options.note ?? null, options.reversed ?? null],
  )).rows[0].id);
  const rent = await expense("SYN-EXP-YER", 10000, "YER", { payee: syntheticPayee });
  await expense("SYN-EXP-SAR", 12345, "SAR", { payee: syntheticPayee, category: syntheticCategory });
  await expense("SYN-EXP-UNDO", -2000, "YER", { payee: syntheticPayee, at: "2027-01-02T06:00:00Z", reversed: rent });
  await expense("SYN-EXP-OTHER", 2000, "USD", { payee: syntheticPayee, category: "synthetic_other" });
  await expense("SYN-EXP-MISSING", 600, "YER", { note: syntheticPayee });
  await expense("SYN-EXP-PREV", 99999, "YER", { payee: syntheticPayee, at: "2026-12-31T20:59:59Z" });
  await expense("SYN-RENT-LEAP", 800, "USD", { payee: syntheticPayee, at: "2028-02-28T21:00:00Z" });
  await expense("SYN-RENT-END", 705, "SAR", { payee: syntheticPayee, at: "2028-12-31T20:59:59Z" });
  await expense("SYN-RENT-AFTER", 90000, "YER", { payee: syntheticPayee, at: "2028-12-31T21:00:00Z" });
  const payout = await expense("SYN-EXP-PAYOUT", 5000, "YER", { party: supplier, payee: "اسم المورد القديم" });
  const payable = (await q("INSERT INTO payables(party_id,category,description,amount_minor,currency,base_amount_minor) VALUES ($1,'synthetic_other','Synthetic account',3000,'YER',3000) RETURNING id", [supplier])).rows[0].id;
  await q("INSERT INTO expense_payable_allocations(expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor) VALUES ($1,$2,3000,'YER',1,3000)", [payout, payable]);

  const receipt = async (reference: string, out: number, currency: string, method: string | null, origin?: number) =>
    Number((await q("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_at,reversal_of_id,note) VALUES ($1,$2,$3,$4,$5,$6,1,$5,$6,$7,'2027-01-01T12:00:00Z',$8,'ردّ حقيقي مذكور في النص وحده') RETURNING id",
      [reference, patient, shift, origin ? "refund" : "payment", out, currency, method, origin ?? null])).rows[0].id);
  const audit = async (id: number, reference: string, action: string, details: Record<string, unknown>) => {
    await q("INSERT INTO audit_log(action,entity,entity_id,summary,details,actor) VALUES ($1,'payment',$2,$3,$4::jsonb,'synthetic')",
      [action, String(id), reference, JSON.stringify({ المريض: patient, ...details })]);
  };
  const cashOriginal = await receipt("SYN-RC-COLLECTED", 1000, "YER", "cash");
  const bankOriginal = await receipt("SYN-RC-BANK-ORIG", 1200, "SAR", "transfer");
  const voidOriginal = await receipt("SYN-RC-VOID-ORIG", 200, "YER", "cash");
  const cashRefund = await receipt("SYN-RC-CASH", 100, "YER", "cash", cashOriginal);
  const bankRefund = await receipt("SYN-RC-BANK", 500, "SAR", "transfer", bankOriginal);
  await audit(cashRefund, "SYN-RC-CASH", "payment.refund", { المبلغ: 100, العملة: "YER" });
  await audit(bankRefund, "SYN-RC-BANK", "payment.refund", { المبلغ: 500, العملة: "SAR" });
  await receipt("SYN-RC-VOID", 200, "YER", "cash", voidOriginal);
  await audit(voidOriginal, "SYN-RC-VOID-ORIG", "payment.correct",
    { الطريقة: "إبطال", سند_العكس: "SYN-RC-VOID", المبلغ_المعكوس: 200, العملة_المعكوسة: "YER" });
  await receipt("SYN-RC-UNPROVED", 80, "YER", "cash", cashOriginal);

  const journal = async (lines: [string,string,number][]) => {
    const id = Number((await q("INSERT INTO journal_manual(entry_date,description,created_by) VALUES ($1,'Synthetic journal','synthetic') RETURNING id", [SELECTED_DAY])).rows[0].id);
    for (const [code, side, minor] of lines) await q("INSERT INTO journal_manual_lines(entry_id,account_code,currency,side,amount_minor) VALUES ($1,$2,'YER',$3,$4)", [id,code,side,minor]);
    return id;
  };
  transferId = await journal([["1101","credit",1000],["1111","debit",1000]]);
  unprovedManualId = await journal([["1101","credit",700],["5501","debit",700]]);
  await journal([["1101","credit",50],["1101","debit",50]]);
}, 90_000);

afterAll(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("disbursement reports use recorded, non-duplicated native movements", () => {
  it("offers dedicated reports and Today's existing Collections without leaking them to reception", () => {
    const page = renderToStaticMarkup(<ReportsPage />);
    expect(page).toContain('report=collections&amp;preset=today');
    expect(page).toContain('report=daily-outflow&amp;preset=today');
    expect(page).toContain('report=expense-payees&amp;preset=today');
    session.role = "reception";
    try {
      expect(renderToStaticMarkup(<ReportsPage />)).not.toContain('report=expense-payees');
    } finally { session.role = "admin"; }
  });

  it("combines payee and keyed/legacy category filters, preserving signed YER and SAR across print / screen / CSV", async () => {
    const all = await result(standardParams("expense-payees"));
    const payee = all.expenseFilterOptions?.payees.find(option => option.label.includes(syntheticPayee));
    const rent = all.expenseFilterOptions?.categories.find(option => option.label === syntheticCategory);
    expect(payee?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(rent?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(all.expenseFilterOptions?.categories.filter(option => option.label === syntheticCategory)).toHaveLength(1);
    expect(all.rows?.find(row => row.reference === "SYN-EXP-MISSING")?.recipient).toBe("مستفيد غير مسجّل");
    const params = standardParams("expense-payees", { expenseRecipient: payee!.value, expenseCategory: rent!.value });
    expect(normalizeSavedReportQuery("expense-payees", new URLSearchParams(params).toString()).queryString).toContain(payee!.value);
    expect(() => normalizeSavedReportQuery("expense-payees", "report=expense-payees&expenseRecipient=raw-name")).toThrow();
    const filtered = await result(params);
    expect(filtered.rows?.map(row => [row.reference, row.currency, row.amount])).toEqual([
      ["SYN-EXP-UNDO", "YER", -2000], ["SYN-EXP-SAR", "SAR", 12345], ["SYN-EXP-YER", "YER", 10000],
    ]);
    expect(checkCards(filtered)).toMatchObject({ "net-YER": 8000, "net-SAR": 12345 });
    const controls = renderToStaticMarkup(<FilterBar state={{ preset:"custom", from:SELECTED_DAY,to:NEXT_DAY,specialty:null,
      doctorId:null,patientId:null,serviceId:null,currency:"all",patientStatus:"all",debtStatus:"all",debtMode:"outstanding",
      compare:"none",method:null,receivedBy:null,expenseRecipient:payee!.value,expenseCategory:rent!.value }}
      onChange={() => {}} options={null} showDebtMode={false} showCompare={false}
      onPatientPicked={() => {}} onApply={() => {}} disbursementMode="expense-payees" expenseOptions={filtered.expenseFilterOptions} />);
    expect(controls).toContain(syntheticPayee);
    expect(controls).toContain(syntheticCategory);
    for (const output of [screen(filtered), await official(params), reportCsv(filtered.columns!, filtered.rows!, filtered.baseCurrency)]) {
      for (const ref of ["SYN-EXP-UNDO","SYN-EXP-YER","SYN-EXP-SAR"]) expect(output).toContain(ref);
      for (const ref of ["SYN-EXP-MISSING","SYN-EXP-PAYOUT","SYN-EXP-OTHER","SYN-EXP-PREV"]) expect(output).not.toContain(ref);
    }
    const sarOnly = await result({ ...params, currency: "SAR" });
    expect(sarOnly.rows?.map(row => row.reference)).toEqual(["SYN-EXP-SAR"]);
    expect(checkCards(sarOnly)).not.toHaveProperty("net-YER");
    expect((await result({ ...params, expenseRecipient: "a".repeat(64) })).rows).toEqual([]);
  });

  it("returns an inclusive 731-day rent window across a leap day and clinic midnight in screen, print and CSV", async () => {
    const twoYears = standardParams("expense-payees", { to: LEAP_YEAR_END });
    const choices = await result(twoYears);
    const payee = choices.expenseFilterOptions?.payees.find(option => option.label.includes(syntheticPayee));
    const rent = choices.expenseFilterOptions?.categories.find(option => option.label === syntheticCategory);
    expect(payee?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(rent?.value).toMatch(/^[a-f0-9]{64}$/);
    const params = { ...twoYears, expenseRecipient: payee!.value, expenseCategory: rent!.value };
    const saved = normalizeSavedReportQuery("expense-payees", new URLSearchParams(params).toString());
    expect(Object.fromEntries(new URLSearchParams(saved.queryString))).toEqual(params);
    const filtered = await result(params);
    expect([filtered.from, filtered.to]).toEqual([SELECTED_DAY, LEAP_YEAR_END]);
    expect(filtered.rows?.map(row => [row.reference, row.day, row.amount, row.currency])).toEqual([
      ["SYN-RENT-END", LEAP_YEAR_END, 705, "SAR"],
      ["SYN-RENT-LEAP", "2028-02-29", 800, "USD"],
      ["SYN-EXP-UNDO", NEXT_DAY, -2000, "YER"],
      ["SYN-EXP-SAR", SELECTED_DAY, 12345, "SAR"],
      ["SYN-EXP-YER", SELECTED_DAY, 10000, "YER"],
    ]);
    expect(checkCards(filtered)).toMatchObject({ "net-YER": 8000, "net-SAR": 13050, "net-USD": 800 });
    for (const output of [screen(filtered), await official(params), reportCsv(filtered.columns!, filtered.rows!, filtered.baseCurrency)]) {
      for (const row of filtered.rows!) expect(output).toContain(row.reference);
      for (const ref of ["SYN-EXP-PREV", "SYN-RENT-AFTER", "SYN-EXP-OTHER", "SYN-EXP-MISSING", "SYN-EXP-PAYOUT"]) {
        expect(output).not.toContain(ref);
      }
    }
  });

  it("keeps 731-day saved legacy payee and raw-category selectors exact in filters, screen, print and CSV", async () => {
    const storedName = "مستفيد محفوظ لفترة سنتين اصطناعية";
    const rawCategory = "\t rent ";
    const token = (scope: string, key: string) => createHash("sha256").update(scope + "\0" + key, "utf8").digest("hex");
    // The independently approved composer fences padding to a verified system
    // seed already present on the voucher date; anchor that synthetic seed.
    const systemRent = await q("UPDATE expense_categories SET created_at='2027-01-06T00:00:00Z' WHERE key='rent' AND is_system RETURNING name");
    expect(systemRent.rows).toHaveLength(1);
    const party = Number((await q("INSERT INTO parties(kind,name) VALUES ('supplier','جهة اصطناعية بفترة سنتين') RETURNING id")).rows[0].id);
    const spend = (ref: string, at: string, minor: number, currency: string, category = rawCategory, id: number | null = null) => q(
      `INSERT INTO expenses(voucher_number,category,party_id,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_at)
       SELECT $1,$2,$3,$4,s.id,$5,$6,1,$5,$6,$7::timestamptz FROM cashier_shifts s WHERE status='open' LIMIT 1`,
      [ref, category, id, storedName, minor, currency, at],
    );
    const older = "SYN-LONG-BEFORE-SEED", leap = "SYN-LONG-RAW-LEAP", linked = "SYN-LONG-LINKED",
      other = "SYN-LONG-OTHER-USD", outside = "SYN-LONG-EXCLUDED-MIDNIGHT", anotherPad = "SYN-LONG-DIFFERENT-RAW";
    await spend(older, "2027-01-04T10:00:00Z", 100, "SAR");
    await spend(leap, "2028-02-28T21:00:00Z", 705, "SAR");
    await spend(linked, "2028-12-31T20:59:59Z", 300, "SAR", rawCategory, party);
    await spend(other, "2028-12-31T11:00:00Z", 322, "USD", "synthetic_other");
    await spend(outside, "2028-12-31T21:00:00Z", 999, "SAR");
    await spend(anotherPad, "2028-12-31T05:00:00Z", 900, "SAR", " rent ");

    const expenseRecipient = token("payee", "text:" + storedName);
    const expenseCategory = token("category", rawCategory);
    const saved = normalizeSavedReportQuery("expense-payees", new URLSearchParams(standardParams("expense-payees", {
      to: LEAP_YEAR_END, expenseRecipient, expenseCategory, currency: "SAR",
    })).toString());
    const savedParams = Object.fromEntries(new URLSearchParams(saved.queryString));
    const selected = await result(savedParams);
    expect(selected.rows?.map(row => [row.reference, row.day, row.currency, row.amount])).toEqual([
      [leap, "2028-02-29", "SAR", 705], [older, "2027-01-04", "SAR", 100],
    ]);
    expect(checkCards(selected)).toMatchObject({ "net-SAR": 805 });
    expect(checkCards(selected)).not.toHaveProperty("net-USD");
    expect(selected.expenseFilterOptions?.payees.some(option => option.value === expenseRecipient)).toBe(true);
    expect(selected.expenseFilterOptions?.categories.find(option => option.value === expenseCategory)?.label).toContain("مطابقة نص البند القديم");
    const allCurrencies = await result({ ...savedParams, currency: "all" });
    expect(selected.expenseFilterOptions).toEqual(allCurrencies.expenseFilterOptions);
    const control = renderToStaticMarkup(<FilterBar state={{
      preset:"custom", from:SELECTED_DAY, to:LEAP_YEAR_END, specialty:null, doctorId:null, patientId:null, serviceId:null,
      currency:"SAR", patientStatus:"all", debtStatus:"all", debtMode:"outstanding", compare:"none", method:null, receivedBy:null,
      expenseRecipient, expenseCategory,
    }} onChange={() => {}} options={null} showDebtMode={false} showCompare={false} onPatientPicked={() => {}}
      onApply={() => {}} disbursementMode="expense-payees" expenseOptions={selected.expenseFilterOptions} />);
    expect(control).toContain(LEAP_YEAR_END);
    expect(control).toContain(storedName + " (سندات غير مرتبطة بجهة)");
    expect(control).toContain("مطابقة نص البند القديم");
    for (const output of [screen(selected), await official(savedParams), reportCsv(selected.columns!, selected.rows!, selected.baseCurrency)]) {
      for (const ref of [older, leap]) expect(output).toContain(ref);
      for (const ref of [linked, other, outside, anotherPad]) expect(output).not.toContain(ref);
    }

    const crossRecorded = token("payee-recorded-name:v1", storedName);
    expect((await result({ ...savedParams, expenseRecipient: crossRecorded })).rows?.map(row => row.reference))
      .toEqual([linked, leap, older]);
    const canonical = await result({ ...savedParams, expenseCategory: token("category", "rent") });
    expect(canonical.rows?.map(row => row.reference)).toEqual([anotherPad, leap]);
  });

  it("rejects 732 expense days and 367 outflow days before report reads, while preserving day 366 for outflow", async () => {
    const outflow = standardParams("daily-outflow", { to: "2028-01-01" });
    expect((await result(outflow)).to).toBe("2028-01-01");
    const before = parseFilters(new URLSearchParams(outflow));
    const pool = getPool();
    const reads = vi.spyOn(pool, "query");
    const connections = vi.spyOn(pool, "connect");
    try {
      for (const [report, to, count] of [
        ["expense-payees", "2029-01-01", "٧٣١"],
        ["daily-outflow", "2028-01-02", "٣٦٦"],
      ]) {
        const params = standardParams(report, { to });
        const denied = await api(params);
        expect(denied.status).toBe(400);
        expect((await denied.json()).message).toContain(count);
        await expect(official(params)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
        await expect(buildReport(report, { ...before, to })).rejects.toThrow(count);
      }
      expect(reads).not.toHaveBeenCalled();
      expect(connections).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      connections.mockRestore();
    }
  });

  it("separates single vouchers, audited refunds, receipt corrections and internal transfers without a mixed total", async () => {
    const params = standardParams("daily-outflow", { to: SELECTED_DAY });
    const report = await result(params);
    const rows = report.rows!;
    expect(rows.filter(row => row.reference === "SYN-EXP-PAYOUT")).toMatchObject([{ amount:5000, movement:"سداد التزام بسند صرف" }]);
    expect(rows.find(row => row.reference === "SYN-RC-CASH")).toMatchObject({ amount:100, movement:"ردّ مريض مسجّل", channel:"نقد" });
    expect(rows.find(row => row.reference === "SYN-RC-BANK")).toMatchObject({ amount:500, movement:"ردّ مريض مسجّل", channel:"حوالة" });
    expect(rows.find(row => row.reference === "SYN-RC-VOID")?.movement).toContain("إبطال");
    expect(rows.find(row => row.reference === "SYN-RC-UNPROVED")?.movement).toContain("غير موثّق");
    expect(rows.filter(row => row.reference === "قيد #" + transferId)).toMatchObject([{ amount:1000, movement:"قيد تحويل داخلي — ليس مصروفًا" }]);
    expect(rows.find(row => row.reference === "قيد #" + unprovedManualId)?.movement).toContain("الغرض غير مثبت");
    expect(rows.some(row => row.reference === "SYN-RC-COLLECTED" || row.reference === "SYN-EXP-PREV" || row.reference === "SYN-EXP-UNDO")).toBe(false);
    expect(checkCards(report)).toMatchObject({ "voucher-YER":15600, "voucher-SAR":12345, "voucher-USD":2000,
      "refund-cash-YER":100, "refund-bank-SAR":500, "void-YER":200, "uncertain-YER":80 });
    expect(report.columns?.find(column => column.key === "amount")?.aggregate).toBe("none");
    const csv = reportCsv(report.columns!, rows, report.baseCurrency);
    const paper = await official(params);
    for (const output of [screen(report), paper, csv]) {
      expect(output).toContain("SYN-RC-UNPROVED");
      expect(output).toContain("SYN-EXP-PAYOUT");
      expect(output).toContain("قيد تحويل داخلي");
    }
    expect((await result(standardParams("collections", { to: SELECTED_DAY }))).rows?.map(row => row.nativeMinor))
      .toContain(1000);
  });

  it("does not expose detailed finance to other roles or accept malformed filters", async () => {
    for (const role of [null,"reception","cashier","doctor","accountant"]) {
      session.role = role;
      try {
        for (const id of ["daily-outflow","expense-payees"]) {
          expect((await api(standardParams(id))).status).toBe(role ? 403 : 401);
          await expect(official(standardParams(id))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
        }
      } finally { session.role = "admin"; }
    }
    const invalid: Record<string, string>[] = [
      { from: "2027-02-30" }, { from: "2027-01-03" }, { currency: "unknown" }, { expenseRecipient: syntheticPayee },
    ];
    for (const extra of invalid) {
      const params = standardParams("expense-payees", extra);
      const denied = await api(params);
      expect(denied.status).toBe(400);
      expect(denied.headers.get("cache-control")).toContain("private");
      await expect(official(params)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  });

  if (postgresUrl) it("queries the two-year voucher window once through an index range, not unrelated history", async () => {
    const addFixtures = (prefix: string, start: string, count: number) => q(
      `INSERT INTO expenses(voucher_number,shift_id,category,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_at)
       SELECT $1::text || n, (SELECT MIN(id) FROM cashier_shifts), 'synthetic_rent', 'Synthetic query workload',
              10, 'YER', 1, 10, 'YER', $2::timestamptz + n * INTERVAL '4 hours'
         FROM generate_series(1, $3::int) n`,
      [prefix, start, count],
    );
    await addFixtures("SYN-HISTORY-", "2000-01-01T00:00:00Z", 40_000);
    await addFixtures("SYN-WINDOW-", "2027-01-03T00:00:00Z", 3_650);
    await q("ANALYZE expenses");

    const query = { timeZone: "Asia/Aden", from: SELECTED_DAY, to: LEAP_YEAR_END };
    const statements: { sql: string; values: unknown[] }[] = [];
    await loadPayeeExpenseRangeReport(query, {
      async query(sql, values) { statements.push({ sql, values }); return { rows: [] }; },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toHaveLength(4);
    expect(statements[0].values.slice(0, 3)).toEqual(["Asia/Aden", SELECTED_DAY, LEAP_YEAR_END]);
    expect(statements[0].values[3]).toEqual(expect.stringContaining("\t"));

    type Plan = {
      "Index Name"?: string; "Index Cond"?: string; "Actual Rows": number;
      "Actual Loops": number; "Relation Name"?: string; Alias?: string; "Node Type": string; Plans?: Plan[];
    };
    const explain = await getPool().query<{ "QUERY PLAN": { Plan: Plan }[] }>(
      "EXPLAIN (ANALYZE, FORMAT JSON) " + statements[0].sql, statements[0].values,
    );
    const root = explain.rows[0]["QUERY PLAN"][0].Plan;
    const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const nodes = flatten(root);
    const dateIndex = nodes.find(node => node["Index Name"] === "expenses_created_idx");
    expect(dateIndex?.["Index Cond"]).toMatch(/created_at >= .*created_at </);
    expect(dateIndex?.["Actual Loops"]).toBe(1);
    expect(nodes.some(node => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "expenses" && node.Alias === "e")).toBe(false);

    const report = await result(standardParams("expense-payees", { to: LEAP_YEAR_END }));
    expect(report.rows?.length).toBe(root["Actual Rows"]);
    expect(report.rows?.filter(row => String(row.reference).startsWith("SYN-WINDOW-"))).toHaveLength(3_650);
    expect(report.rows?.some(row => String(row.reference).startsWith("SYN-HISTORY-"))).toBe(false);
  }, 30_000);
});
