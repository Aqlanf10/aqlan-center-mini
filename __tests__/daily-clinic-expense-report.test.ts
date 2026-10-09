import { describe, expect, it, vi } from "vitest";
import {
  buildDailyClinicExpenseReport, DailyClinicExpenseIntegrityError, loadDailyClinicExpenseReport,
  type DailyClinicExpenseSourceRow,
} from "../lib/daily-clinic-expense-report";
import { FinancialCurrencyIntegrityError } from "../lib/money";

const query = { date: "2026-10-07", timeZone: "Asia/Aden" };
function voucher(patch: Partial<DailyClinicExpenseSourceRow> = {}): DailyClinicExpenseSourceRow {
  return { id: 1, voucher_number: "EX-1", created_at: new Date("2026-10-07T09:00:00Z"), shift_id: 1,
    category: "custom_power", category_name: "كهرباء مخصصة", party_id: null, party_name: null, party_kind: null,
    payee_text: "مستفيد نصي", amount_minor: "1000", currency: "YER", reversal_of_id: null,
    original_voucher_number: null, original_currency: null, payable_id: null, payable_source_type: null,
    payable_party_id: null, allocations: [], note: null, created_by: "cashier", ...patch };
}
const allocation = (patch: Record<string, unknown> = {}) => ({ id: 1, payable_id: 10, paid_minor: "400",
  payable_currency: "SAR", settled_minor: "100", source_type: "operational", party_id: 8, ...patch });

describe("clinic-day spending vouchers: native currency and identity", () => {
  it("rejects a date-only string instead of mistaking its day suffix for a timezone", () => {
    expect(() => buildDailyClinicExpenseReport([voucher({ created_at: "2026-10-07" })], query))
      .toThrow(DailyClinicExpenseIntegrityError);
  });

  it("keeps YER/SAR/USD independent without reading recorded/current base equivalents", () => {
    const report = buildDailyClinicExpenseReport([
      voucher(), voucher({ id: 2, voucher_number: "EX-2", currency: "SAR", amount_minor: "1250" }),
      voucher({ id: 3, voucher_number: "EX-3", currency: "USD", amount_minor: "200" }),
    ], query);
    expect(report.totals.netOutflowMinor).toEqual({ YER: 1000, SAR: 1250, USD: 200 });
    expect(report.recipientTotals[0].totals).toEqual(report.totals);
    expect(report.movements.every((row) => row.unallocatedMinor === null)).toBe(true);
  });

  it("filters currency coherently but still rejects an unknown selected-day currency", () => {
    const rows = [voucher(), voucher({ id: 2, currency: "USD", amount_minor: "200" })];
    const report = buildDailyClinicExpenseReport(rows, { ...query, currency: "USD" });
    expect(report.movements).toHaveLength(1);
    expect(report.totals.netOutflowMinor).toEqual({ YER: 0, SAR: 0, USD: 200 });
    expect(() => buildDailyClinicExpenseReport([...rows, voucher({ id: 3, currency: "EUR" })],
      { ...query, currency: "USD" })).toThrow(FinancialCurrencyIntegrityError);
  });

  it("groups stable party IDs, retains recorded names, and never equates textual names with IDs", () => {
    const report = buildDailyClinicExpenseReport([
      voucher({ party_id: 8, party_name: "الاسم الحالي", party_kind: "supplier", payee_text: "الاسم القديم" }),
      voucher({ id: 2, party_id: 8, party_name: "الاسم الحالي", party_kind: "supplier", payee_text: "صيغة أخرى" }),
      voucher({ id: 3, party_id: 9, party_name: "الاسم الحالي", party_kind: "supplier" }),
      voucher({ id: 4, payee_text: "الاسم الحالي" }), voucher({ id: 5, payee_text: null }),
    ], query);
    expect(report.recipientTotals.map((row) => row.recipient.key)).toEqual(["party:8", "party:9", "text:الاسم الحالي", "missing"]);
    expect(report.recipientTotals[0].recordedPayeeTexts).toEqual(["الاسم القديم", "صيغة أخرى"]);
    expect(report.movements[0].recipient).toMatchObject({ displayName: "الاسم الحالي", nameSource: "current_party", recordedPayeeText: "الاسم القديم" });
    expect(report.movements[4].recipient).toMatchObject({ nameSource: "missing", displayName: "مستفيد غير مسجّل" });
    expect(report.movements[4].recipient.displayName).not.toContain("cashier");
    expect(report.movements[4].recipient.displayName).not.toContain("كهرباء");
  });

  it("keeps custom and reversal-only categories and does not clamp a negative day", () => {
    const report = buildDailyClinicExpenseReport([voucher({ id: 2, category: "inactive_custom", category_name: null,
      reversal_of_id: 1, original_voucher_number: "EX-1", original_currency: "YER", amount_minor: "-1000" })], query);
    expect(report.movements[0]).toMatchObject({ categoryLabel: "inactive_custom", kind: "reversal", amountMinor: -1000 });
    expect(report.totals).toMatchObject({ outflowMinor: { YER: 0 }, reversalMinor: { YER: 1000 },
      netOutflowMinor: { YER: -1000 }, reversalCount: 1 });
    expect(report.recipientTotals[0].totals.netOutflowMinor.YER).toBe(-1000);
  });

  it("keeps an original and same-day reversal as two rows with zero net", () => {
    const report = buildDailyClinicExpenseReport([voucher(), voucher({ id: 2, reversal_of_id: 1,
      original_currency: "YER", original_voucher_number: "EX-1", amount_minor: "-1000" })], query);
    expect(report.movements).toHaveLength(2);
    expect(report.totals).toMatchObject({ voucherCount: 2, reversalCount: 1,
      outflowMinor: { YER: 1000 }, reversalMinor: { YER: 1000 }, netOutflowMinor: { YER: 0 } });
  });

  it("labels legacy negative adjustments without inventing a reversal link", () => {
    const report = buildDailyClinicExpenseReport([voucher({ amount_minor: "-100" })], query);
    expect(report.movements[0].kind).toBe("negative_adjustment");
    expect(report.totals.negativeAdjustmentCount).toBe(1);
    expect(report.totals.reversalCount).toBe(0);
    expect(report.totals.netOutflowMinor.YER).toBe(-100);
  });
});

describe("settlement details do not multiply cash or claim expense recognition", () => {
  it("counts one voucher once across multiple payable allocations and preserves native settlement currency", () => {
    const report = buildDailyClinicExpenseReport([voucher({ party_id: 8, party_name: "مختبر", party_kind: "lab",
      allocations: [allocation(), allocation({ id: 2, payable_id: 11, paid_minor: "600", payable_currency: "USD", settled_minor: "50" })] })], query);
    expect(report.movements).toHaveLength(1);
    expect(report.movements[0].allocations).toHaveLength(2);
    expect(report.movements[0].unallocatedMinor).toBe(0);
    expect(report.totals.netOutflowMinor).toEqual({ YER: 1000, SAR: 0, USD: 0 });
    expect(report.movements[0].allocations[0].payableCurrency).toBe("SAR");
  });

  it("mirrors allocation amounts on reversal day", () => {
    const report = buildDailyClinicExpenseReport([voucher({ id: 2, party_id: 8, party_kind: "lab", party_name: "مختبر",
      amount_minor: "-1000", reversal_of_id: 1, original_currency: "YER",
      allocations: [allocation({ paid_minor: "-400", settled_minor: "-100" }),
        allocation({ id: 2, payable_id: 11, paid_minor: "-600", settled_minor: "-150" })] })], query);
    expect(report.movements[0].unallocatedMinor).toBe(0);
    expect(report.totals.netOutflowMinor.YER).toBe(-1000);
  });

  it("keeps opening-debt settlement cash separate from payable recognition", () => {
    const report = buildDailyClinicExpenseReport([voucher({ party_id: 8, party_kind: "supplier", party_name: "مورد",
      payable_id: 10, payable_party_id: 8, payable_source_type: "opening" })], query);
    expect(report.movements[0]).toMatchObject({ payableSourceType: "opening", unallocatedMinor: 0 });
    expect(report.totals.netOutflowMinor.YER).toBe(1000);
    expect(report).not.toHaveProperty("recognizedExpenseMinor");
  });

  it("exposes unallocated supplier residual without asserting a prepayment; doctor/direct payouts have no residual", () => {
    const rows = [voucher({ party_id: 8, party_kind: "supplier", party_name: "مورد", allocations: [allocation()] }),
      voucher({ id: 2, party_id: 9, party_kind: "doctor", party_name: "طبيب" }), voucher({ id: 3 })];
    expect(buildDailyClinicExpenseReport(rows, query).movements.map((row) => row.unallocatedMinor)).toEqual([600, null, null]);
  });

  it.each([
    { payable_id: 10, payable_party_id: 99, payable_source_type: "operational" },
    { allocations: [allocation({ party_id: 99 })] },
    { allocations: [allocation({ paid_minor: "1001" })] },
    { allocations: [allocation({ paid_minor: "-400" })] },
    { allocations: [allocation(), allocation()] },
    { payable_id: 10, payable_party_id: 8, allocations: [allocation()] },
  ])("rejects ownership/coverage ambiguity rather than guessing (%j)", (patch) => {
    expect(() => buildDailyClinicExpenseReport([voucher({ party_id: 8, party_kind: "lab", ...patch })], query))
      .toThrow(DailyClinicExpenseIntegrityError);
  });
});

describe("complete source scope and safe integer/time boundaries", () => {
  it("retains more than 1000 rows and deterministic timestamp/id ordering", async () => {
    const rows = Array.from({ length: 1005 }, (_, i) => voucher({ id: 1005 - i, amount_minor: "1" }));
    const runner = { query: vi.fn().mockResolvedValue({ rows }) };
    const report = await loadDailyClinicExpenseReport(query, runner);
    expect(report.movements).toHaveLength(1005);
    expect(report.movements[0].id).toBe(1);
    expect(report.movements[1004].id).toBe(1005);
    expect(report.totals.netOutflowMinor.YER).toBe(1005);
    expect(runner.query).toHaveBeenCalledTimes(1);
    const [sql, values] = runner.query.mock.calls[0];
    expect(values).toEqual(["Asia/Aden", "2026-10-07"]);
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("jsonb_agg");
    expect(sql).not.toMatch(/LIMIT\s+(?:500|1000)\b/i);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });

  it("uses clinic midnight, not UTC midnight or the shift opening date", () => {
    const report = buildDailyClinicExpenseReport([voucher({ created_at: "2026-10-06T21:00:00Z", shift_id: 888 }),
      voucher({ id: 2, created_at: "2026-10-07T20:59:59.999Z" })], query);
    expect(report.movements.map((row) => row.clinicDate)).toEqual([query.date, query.date]);
    expect(report.movements[0].clinicTime).toBe("00:00:00");
    expect(() => buildDailyClinicExpenseReport([voucher({ created_at: "2026-10-07T21:00:00Z" })], query))
      .toThrow(DailyClinicExpenseIntegrityError);
  });

  it("returns explicit three-currency zeroes on an empty day", () => {
    expect(buildDailyClinicExpenseReport([], query).totals.netOutflowMinor).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });

  it.each(["2026-02-30", "2026-13-01", "0000-01-01", "07-10-2026"])("rejects invalid date %s", (date) => {
    expect(() => buildDailyClinicExpenseReport([], { ...query, date })).toThrow(DailyClinicExpenseIntegrityError);
  });

  it("rejects malformed/unsafe money, duplicate vouchers, positive reversals, and bad timezone", () => {
    for (const amount_minor of ["9007199254740992", "1.2", null, "NaN"]) {
      expect(() => buildDailyClinicExpenseReport([voucher({ amount_minor })], query)).toThrow(DailyClinicExpenseIntegrityError);
    }
    expect(() => buildDailyClinicExpenseReport([voucher(), voucher()], query)).toThrow(DailyClinicExpenseIntegrityError);
    expect(() => buildDailyClinicExpenseReport([voucher({ reversal_of_id: 2 })], query)).toThrow(DailyClinicExpenseIntegrityError);
    expect(() => buildDailyClinicExpenseReport([], { ...query, timeZone: "Not/AZone" })).toThrow(DailyClinicExpenseIntegrityError);
    expect(() => buildDailyClinicExpenseReport([voucher({ amount_minor: String(Number.MAX_SAFE_INTEGER) }), voucher({ id: 2 })], query))
      .toThrow(DailyClinicExpenseIntegrityError);
  });
});
