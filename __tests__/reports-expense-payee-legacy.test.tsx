import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reportCsv } from "../lib/report-export";
import type { ReportResult } from "../lib/reports-types";
import { clinicDateString } from "../lib/schedule";

vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ role: "admin", username: "SYN-EXPENSE-REPORT" }),
}));

const postgresUrl = process.env.TEST_EXPENSE_REPORT_LEGACY_URL;
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("USE_LOCAL_DB", postgresUrl ? "false" : "true");
vi.stubEnv("DATABASE_URL", postgresUrl ?? "");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
vi.stubEnv("SKIP_SEED", "");
const { ensureSchema, getPool, resetPoolForTesting, listExpensesBetween,
  createExpenseCategory, deleteExpenseCategory } = await import("../lib/db");
const { GET: reportGet } = await import("../app/api/reports/route");
const { POST: createVoucher } = await import("../app/api/expenses/route");
const { default: PrintPage } = await import("../app/print/report/page");
const { normalizeSavedReportQuery } = await import("../lib/saved-reports");

const recordedName = "مؤجر اصطناعي بالاسم المسجّل";
const legacyRef = "SYN-PAYEE-LEGACY";
const namesakeRef = "SYN-PAYEE-NAMESAKE";
const usdRef = "SYN-USD-OTHER";
const missingRef = "SYN-PAYEE-MISSING";
let modernRef: string, date: string, partyId: number, rentName: string;

const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
const params = (extra: Record<string, string> = {}) => ({
  report: "expense-payees", preset: "custom", from: date, to: date, ...extra,
});
const request = (extra: Record<string, string> = {}) =>
  reportGet(new Request("https://synthetic.invalid/api/reports?" + new URLSearchParams(params(extra))));
async function report(extra: Record<string, string> = {}) {
  const response = await request(extra);
  expect(response.status).toBe(200);
  return (await response.json()).result as ReportResult;
}

beforeAll(async () => {
  await ensureSchema();
  // Native server stays UTC to exercise the real clinic-zone predicate.
  await q(postgresUrl ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'Asia/Aden'");
  const shift = Number((await q("INSERT INTO cashier_shifts(opened_by, opening_yer) VALUES ('synthetic legacy fixture', 10000) RETURNING id")).rows[0].id);
  partyId = Number((await q("INSERT INTO parties(kind,name) VALUES ('supplier','مؤجر اصطناعي بعد تحديث الاسم') RETURNING id")).rows[0].id);
  const unrelatedParty = Number((await q("INSERT INTO parties(kind,name) VALUES ('supplier',$1) RETURNING id", [recordedName])).rows[0].id);
  const rentSeed = (await q("SELECT name, is_system FROM expense_categories WHERE key='rent'")).rows[0];
  expect(rentSeed?.is_system).toBe(true);
  rentName = String(rentSeed.name);
  await q("INSERT INTO expense_categories(key,name) VALUES('syn_unrelated','بند مستقل اصطناعي')");
  const response = await createVoucher(new Request("https://synthetic.invalid/api/expenses", {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "syn-report-payee-legacy-01" },
    body: JSON.stringify({ category: "rent", payee: " " + recordedName + " ", partyId: String(partyId), amount: "1000", currency: "YER",
      prepayment: true, prepaymentReason: "دفعة مقدمة اختبارية لا تتصل بالعيادة" }),
  }));
  const saved = await response.json();
  expect(response.status, JSON.stringify(saved)).toBe(201);
  expect(saved).toMatchObject({ category: "rent", payeeText: recordedName, partyId, amountMinor: 1000, currency: "YER" });
  modernRef = saved.voucherNumber;
  date = clinicDateString(new Date(saved.createdAt), "Asia/Aden");

  // Historical unlinked name and a raw exact catalogue-name category; a
  // namesake current party and a memo that must not count as recorded evidence.
  const fixture = (ref: string, category: string, recipient: string | null, linked: number | null, currency: string, minor: number) => q(
    `INSERT INTO expenses(voucher_number,category,party_id,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_at,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,$6,'YER',$8::timestamptz,$9)`,
    [ref, category, linked, recipient, shift, minor, currency, saved.createdAt, recordedName],
  );
  await fixture(legacyRef, rentName, recordedName, null, "SAR", 2600);
  await fixture(namesakeRef, "rent", null, unrelatedParty, "YER", 3000);
  await fixture(usdRef, "syn_unrelated", "مستفيد مستقل اصطناعي", null, "USD", 500);
  await fixture(missingRef, "rent", null, null, "YER", 50);
}, 90_000);

afterAll(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("expense-payee report follows recorded voucher identity, not the memo", () => {
  it("uses the same unfiltered voucher references, original currency and signed amounts as the finance list", async () => {
    const all = await report();
    const finance = await listExpensesBetween(date, date);
    expect(finance).toHaveLength(5);
    expect(all.rows?.map(row => [row.reference, row.currency, row.amount]).sort()).toEqual(
      finance.map(voucher => [voucher.voucherNumber, voucher.currency, voucher.amountMinor]).sort(),
    );
    expect(Object.fromEntries(all.kpis.filter(card => card.key.startsWith("net-")).map(card => [card.currency, card.minor])))
      .toEqual({ YER:4050, SAR:2600, USD:500 });
  });

  it("allows explicit exact recorded-name matching across legacy and linked vouchers, but keeps party selection ID-only", async () => {
    const all = await report();
    const name = all.expenseFilterOptions?.payees.find(option => option.label === recordedName + " (مطابقة الاسم المسجّل)");
    const unlinked = all.expenseFilterOptions?.payees.find(option => option.label === recordedName + " (سندات غير مرتبطة بجهة)");
    const party = all.expenseFilterOptions?.payees.find(option => option.label.endsWith("(#" + partyId + ")"));
    const rent = all.expenseFilterOptions?.categories.find(option => option.label === rentName);
    expect(name?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(unlinked?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(unlinked?.value).not.toBe(name?.value);
    expect(party?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(rent?.value).toMatch(/^[a-f0-9]{64}$/);
    // Reuse the exact URL selector for the same originally-recorded text.
    expect(normalizeSavedReportQuery("expense-payees", new URLSearchParams(params({ expenseRecipient: name!.value })).toString()).queryString)
      .toContain(name!.value);
    const selected = { expenseRecipient: name!.value, expenseCategory: rent!.value };
    const exactRecorded = await report(selected);
    expect(exactRecorded.rows?.map(row => row.reference).sort()).toEqual([legacyRef, modernRef].sort());
    expect(exactRecorded.filtersLabel).toContain("مطابقة");
    const filteredByParty = await report({ expenseRecipient: party!.value, expenseCategory: rent!.value });
    expect(filteredByParty.rows?.map(row => row.reference)).toEqual([modernRef]);
    const unlinkedOnly = await report({ expenseRecipient: unlinked!.value, expenseCategory: rent!.value });
    expect(unlinkedOnly.rows?.map(row => row.reference)).toEqual([legacyRef]);
    // An exact-match option may be used in print/CSV, without linking histories.
    const printed = renderToStaticMarkup(await PrintPage({ searchParams: Promise.resolve(params(selected)) }));
    const csv = reportCsv(exactRecorded.columns!, exactRecorded.rows!, exactRecorded.baseCurrency);
    for (const output of [printed, csv]) {
      expect(output).toContain(legacyRef);
      expect(output).toContain(modernRef);
      for (const excluded of [namesakeRef, usdRef, missingRef]) expect(output).not.toContain(excluded);
    }
  });

  it("lists payee/category choices for the date independently of currency or an unmatched selector without broadening rows", async () => {
    const all = await report();
    const selected = await report({ currency: "SAR" });
    expect(selected.expenseFilterOptions).toEqual(all.expenseFilterOptions);
    expect(selected.rows?.map(row => [row.reference, row.currency, row.amount])).toEqual([[legacyRef, "SAR", 2600]]);
    const category = all.expenseFilterOptions?.categories.find(option => option.label === "بند مستقل اصطناعي");
    expect(category?.value).toMatch(/^[a-f0-9]{64}$/);
    const none = await report({ currency: "SAR", expenseCategory: category!.value });
    expect(none.expenseFilterOptions).toEqual(all.expenseFilterOptions);
    expect(none.rows).toEqual([]);
    expect(none.filtersLabel).toContain("بند مستقل اصطناعي");
    expect(none.filtersLabel).not.toContain("غير موجود");
  });
});

let voucherSeq = 0;
async function sendVoucher(body: Record<string, unknown>) {
  return createVoucher(new Request("https://synthetic.invalid/api/expenses", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": `syn-report-payee-legacy-send-${++voucherSeq}` },
    body: JSON.stringify(body),
  }));
}

const rawVoucher = (reference: string, category: string, amountMinor: number) => q(
  `INSERT INTO expenses(voucher_number,category,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,created_at)
   SELECT $1, $2, $3, s.id, $4,'YER',1,$4,NOW() FROM cashier_shifts s WHERE status='open' LIMIT 1`,
  [reference, category, recordedName, amountMinor],
);

describe("legacy category presentation does not reinterpret a voucher or liability", () => {
  it("admits a writer-accepted exact padded key for the linked supplier without mistaking unpaid or unlinked amounts for it", async () => {
    const payableId = Number((await q(
      `INSERT INTO payables(party_id,category,description,amount_minor,currency,base_amount_minor)
       VALUES($1,'rent','Synthetic lease payable',2100,'YER',2100) RETURNING id`, [partyId],
    )).rows[0].id);
    // This valid payable settlement omits the free-text payee; the writer
    // links the authority from the payable and preserves the original raw key.
    const padded = "\t rent ";
    const response = await sendVoucher({ category: padded, payableId, amount: "300", currency: "YER" });
    const saved = await response.json();
    expect(response.status, JSON.stringify(saved)).toBe(201);
    expect(saved).toMatchObject({ category: padded, partyId, payeeText: null, amountMinor: 300, payableId, payableSettledMinor: 300 });
    const rentSeedId = Number((await q("SELECT id FROM expense_categories WHERE key='rent'")).rows[0].id);
    expect(await deleteExpenseCategory(rentSeedId)).toEqual({ success: true, deactivated: true });
    expect((await q("SELECT key, is_system, is_active FROM expense_categories WHERE id=$1", [rentSeedId])).rows[0])
      .toEqual({ key: "rent", is_system: true, is_active: false });
    const exactLegacyRef = "SYN-RENT-LEGACY-EXACT-CATALOGUE";
    const rawAliasRef = "SYN-RENT-UNVERIFIED-RAW-ALIAS";
    await q("INSERT INTO expense_categories(key,name) VALUES('syn_legacy_exact','  rent  ')");
    await rawVoucher(exactLegacyRef, "  rent  ", 40);
    await rawVoucher(rawAliasRef, "إيجار", 60);

    const all = await report();
    const selectedParty = all.expenseFilterOptions?.payees.find(option => option.label.endsWith("(#" + partyId + ")"));
    const selectedName = all.expenseFilterOptions?.payees.find(option => option.label === recordedName + " (مطابقة الاسم المسجّل)");
    const selectedRent = all.expenseFilterOptions?.categories.find(option => option.label === rentName);
    expect([selectedParty, selectedName, selectedRent].every(Boolean)).toBe(true);
    const partyWithRent = { expenseRecipient: selectedParty!.value, expenseCategory: selectedRent!.value };
    const displayed = await report(partyWithRent);
    expect(displayed.rows?.map(row => row.reference).sort()).toEqual([modernRef, saved.voucherNumber].sort());
    expect(displayed.rows?.find(row => row.reference === saved.voucherNumber)).toMatchObject({
      amount: 300, currency: "YER", category: rentName, movement: "سداد التزام بسند صرف",
    });
    expect(displayed.kpis.find(card => card.key === "net-YER")?.minor).toBe(1300);
    expect((await report({ ...partyWithRent, currency: "SAR" })).rows).toEqual([]);
    const byName = await report({ expenseRecipient: selectedName!.value, expenseCategory: selectedRent!.value });
    expect(byName.rows?.map(row => row.reference).sort()).toEqual([legacyRef, modernRef].sort());
    const rentOnly = await report({ expenseCategory: selectedRent!.value });
    expect(rentOnly.rows?.some(row => row.reference === exactLegacyRef || row.reference === rawAliasRef)).toBe(false);
    expect((await listExpensesBetween(date, date)).find(row => row.voucherNumber === saved.voucherNumber)?.category).toBe(padded);
    const strictOutflow = await report({ report: "daily-outflow" });
    expect(strictOutflow.rows?.find(row => row.reference === saved.voucherNumber)?.category).toBe(padded);

    // Exact legacy selector from 759: sha256("category\\0" + "\\t rent ").
    // A later report canonicalizes the voucher without invalidating this URL.
    const rawToken = "74e8b6fa0badf91a7b39d6df815514982ad35cf462dec9c2aeda9b1bf9d168b0";
    const canonicalToken = "ca46db7f3ed3805eaca6a9fab01a6b339bd095547691a4f209b343ddd3eb7145";
    expect(selectedRent?.value).toBe(canonicalToken);
    expect(all.expenseFilterOptions?.categories.some(option => option.value === rawToken)).toBe(false);
    const rawToday = await report({ expenseCategory: rawToken });
    expect(rawToday.rows?.map(row => row.reference)).toEqual([saved.voucherNumber]);
    expect(rawToday.expenseFilterOptions?.categories.find(option => option.value === rawToken)?.label)
      .toContain("مطابقة نص البند القديم");

    const differentPad = "SYN-RENT-DIFFERENT-PADDING";
    const beforeSeedSameRaw = "SYN-RENT-OLD-SAME-PADDING";
    const unverifiedCustom = "SYN-RENT-OTHER-CUSTOM-PADDING";
    await rawVoucher(differentPad, " rent ", 140);
    await rawVoucher(unverifiedCustom, " syn_legacy_exact ", 150);
    const seedTime = (await q("SELECT created_at FROM expense_categories WHERE id=$1", [rentSeedId])).rows[0].created_at;
    const beforeSeed = new Date(new Date(seedTime).getTime() - 86_400_000);
    await q(`INSERT INTO expenses(voucher_number,category,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,created_at)
      SELECT $1, $2, $3, s.id, 70,'YER',1,70,$4::timestamptz FROM cashier_shifts s WHERE status='open' LIMIT 1`,
    [beforeSeedSameRaw, padded, recordedName, beforeSeed.toISOString()]);
    const historic = { from: clinicDateString(beforeSeed, "Asia/Aden"), currency: "YER" };
    const legacySaved = normalizeSavedReportQuery("expense-payees", new URLSearchParams(params({
      ...historic, expenseCategory: rawToken,
    })).toString());
    const legacyParams = Object.fromEntries(new URLSearchParams(legacySaved.queryString));
    expect(legacyParams.expenseCategory).toBe(rawToken);
    const legacyMatch = await report(legacyParams);
    expect(legacyMatch.rows?.map(row => row.reference).sort()).toEqual([beforeSeedSameRaw, saved.voucherNumber].sort());
    expect(legacyMatch.filtersLabel).toContain("مطابقة نص البند القديم");
    expect(legacyMatch.kpis.find(card => card.key === "net-YER")?.minor).toBe(370);
    const legacyPrinted = renderToStaticMarkup(await PrintPage({ searchParams: Promise.resolve(legacyParams) }));
    const legacyCsv = reportCsv(legacyMatch.columns!, legacyMatch.rows!, legacyMatch.baseCurrency);
    for (const output of [legacyPrinted, legacyCsv]) {
      expect(output).toContain(beforeSeedSameRaw);
      expect(output).toContain(saved.voucherNumber);
      for (const omitted of [differentPad, unverifiedCustom, exactLegacyRef, rawAliasRef, modernRef]) {
        expect(output).not.toContain(omitted);
      }
    }
    const canonical = await report({ ...historic, expenseCategory: canonicalToken });
    expect(canonical.rows?.map(row => row.reference)).toEqual(expect.arrayContaining([modernRef, saved.voucherNumber, differentPad]));
    expect(canonical.rows?.some(row => [beforeSeedSameRaw, unverifiedCustom, exactLegacyRef, rawAliasRef].includes(String(row.reference)))).toBe(false);
  });

  it("preserves a padded custom voucher across later catalogue creation, removal, and key reuse", async () => {
    const key = "syn_future_rent_custom";
    const raw = " \t" + key + " ";
    const response = await sendVoucher({ category: raw, payee: recordedName, amount: "700", currency: "YER" });
    const historical = await response.json();
    expect(response.status, JSON.stringify(historical)).toBe(201);
    expect(historical.category).toBe(raw);
    const before = await report();
    const oldOption = before.expenseFilterOptions?.categories.find(option => option.label.includes(key));
    expect(oldOption?.value).toMatch(/^[a-f0-9]{64}$/);

    const created = await createExpenseCategory({ key, name: "تصنيف اصطناعي ظهر لاحقًا", accountCode: "5901" });
    expect((await report()).expenseFilterOptions?.categories).toContainEqual(oldOption);
    expect(await deleteExpenseCategory(created.id)).toEqual({ success: true, deactivated: false });
    const recreated = await createExpenseCategory({ key, name: "تصنيف اصطناعي مختلف بنفس المفتاح", accountCode: "5501" });
    expect(recreated.id).not.toBe(created.id);
    const currentResponse = await sendVoucher({ category: key, payee: recordedName, amount: "110", currency: "YER" });
    const current = await currentResponse.json();
    expect(currentResponse.status, JSON.stringify(current)).toBe(201);

    const after = await report();
    expect(after.expenseFilterOptions?.categories).toContainEqual(oldOption);
    expect(oldOption?.label).toContain("بند قديم غير مربوط");
    const newOption = after.expenseFilterOptions?.categories.find(option => option.label === recreated.name);
    expect(newOption?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(newOption?.value).not.toBe(oldOption?.value);
    expect((await report({ expenseCategory: oldOption!.value })).rows)
      .toMatchObject([{ reference: historical.voucherNumber, amount: 700, currency: "YER" }]);
    expect((await report({ expenseCategory: newOption!.value })).rows)
      .toMatchObject([{ reference: current.voucherNumber, amount: 110, currency: "YER" }]);
    expect((await listExpensesBetween(date, date)).find(row => row.voucherNumber === historical.voucherNumber)?.category).toBe(raw);
  });

  it("refuses to classify padding from before the protected Rent seed existed", async () => {
    const created = (await q("SELECT created_at FROM expense_categories WHERE key='rent'")).rows[0].created_at;
    const earlier = new Date(new Date(created).getTime() - 86_400_000);
    const reference = "SYN-RENT-BEFORE-CANONICAL-SEED";
    await q(`INSERT INTO expenses(voucher_number,category,payee_text,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,created_at)
      SELECT $1, ' rent ', $2, s.id, 70, 'YER', 1, 70, $3::timestamptz
        FROM cashier_shifts s WHERE status='open' LIMIT 1`, [reference, recordedName, earlier.toISOString()]);
    const range = { from: clinicDateString(earlier, "Asia/Aden") };
    const all = await report(range);
    expect(all.rows?.find(row => row.reference === reference)).toMatchObject({ currency: "YER", amount: 70 });
    const expectedRent = all.expenseFilterOptions?.categories.find(option => option.label === rentName);
    expect(expectedRent?.value).toMatch(/^[a-f0-9]{64}$/);
    expect((await report({ ...range, expenseCategory: expectedRent!.value })).rows?.some(row => row.reference === reference)).toBe(false);
    expect(all.rows?.find(row => row.reference === reference)?.category).toContain("بند قديم غير مربوط");
  });

  it("prints and exports a schema-valid blank legacy label as unclassified, preserving its signed amount and normal writer guard", async () => {
    const reference = "SYN-LEGACY-UNCLASSIFIED";
    await rawVoucher(reference, " \t ", -125);
    const finance = await listExpensesBetween(date, date);
    expect(finance.find(row => row.voucherNumber === reference)).toMatchObject({ category: " \t ", amountMinor: -125, currency: "YER" });
    const rejectedWriter = await sendVoucher({ category: " ", payee: recordedName, amount: "99", currency: "YER" });
    expect(rejectedWriter.status).toBe(400);
    const all = await report();
    const unclassified = all.expenseFilterOptions?.categories.find(option => option.label === "بند غير مسجّل");
    expect(unclassified?.value).toMatch(/^[a-f0-9]{64}$/);
    const filter = { expenseCategory: unclassified!.value, currency: "YER" };
    const selected = await report(filter);
    expect(selected.rows).toMatchObject([{ reference, amount: -125, currency: "YER", category: "بند غير مسجّل" }]);
    expect(selected.rows).toHaveLength(1);
    expect(selected.kpis.find(card => card.key === "net-YER")?.minor).toBe(-125);
    const printed = renderToStaticMarkup(await PrintPage({ searchParams: Promise.resolve(params(filter)) }));
    const csv = reportCsv(selected.columns!, selected.rows!, selected.baseCurrency);
    for (const output of [printed, csv]) {
      expect(output).toContain(reference);
      expect(output).toContain("بند غير مسجّل");
      expect(output).not.toContain(modernRef);
    }
    expect((await request({ report: "daily-outflow" })).status).toBe(500);
  });
});
