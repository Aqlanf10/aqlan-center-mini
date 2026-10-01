import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { arrivalSuggestions, buildArrivalCurrencyLines } from "../lib/arrival-panel";

/**
 * (P0-D) لوحة الوصول: كل عملة على حدة، والاقتراح من مصدره الصحيح (الرصيد السابق ⇒ opening_currency،
 * قسط الخطة ⇒ مسار القسط)، ولا شرط دفعٍ للدخول.
 */
const TODAY = "2026-10-01";
const legacy = (overrides: Partial<{ suggestedMinor: number; overdueMinor: number; nextDueDate: string | null; arrangementRemainingMinor: number; completed: boolean }> = {}) => ({
  id: 9, currency: "YER" as const, cadence: "per_visit" as const,
  progress: { suggestedMinor: 30000, overdueMinor: 0, nextDueDate: null, arrangementRemainingMinor: 350000, completed: false, ...overrides },
});

describe("(P0-D) arrival lines per currency", () => {
  it("the legacy orthodontic patient: 350,000 YER old balance, 30,000 suggested, no overdue", () => {
    const lines = buildArrivalCurrencyLines({
      today: TODAY,
      balances: [{ currency: "YER", dueMinor: 350000 }],
      openings: [{ currency: "YER", remainingMinor: 350000 }],
      arrangements: [legacy()],
      plans: [],
      openInvoices: [],
    });
    expect(lines).toEqual([expect.objectContaining({
      currency: "YER", balanceMinor: 350000, openingRemainingMinor: 350000, sources: ["opening"],
      legacy: expect.objectContaining({ suggestedMinor: 30000, overdueMinor: 0 }),
    })]);
    expect(arrivalSuggestions(lines)).toEqual([
      { kind: "legacy", currency: "YER", amountMinor: 30000, planId: null, label: "قسط الرصيد السابق" },
    ]);
  });

  it("old balance + a new 15,000 filling: total due 335,000 but the legacy suggestion stays on the old balance", () => {
    const lines = buildArrivalCurrencyLines({
      today: TODAY,
      balances: [{ currency: "YER", dueMinor: 335000 }],
      openings: [{ currency: "YER", remainingMinor: 320000 }],
      arrangements: [legacy({ arrangementRemainingMinor: 320000 })],
      plans: [],
      openInvoices: [{ currency: "YER", count: 1 }],
    });
    expect(lines[0]).toMatchObject({ balanceMinor: 335000, openingRemainingMinor: 320000, sources: ["opening", "invoice"], openInvoices: 1 });
    expect(arrivalSuggestions(lines)).toEqual([expect.objectContaining({ kind: "legacy", amountMinor: 30000 })]);
  });

  it("never merges currencies; a SAR plan installment is suggested in SAR next to a YER legacy one", () => {
    const lines = buildArrivalCurrencyLines({
      today: TODAY,
      balances: [{ currency: "YER", dueMinor: 100000 }, { currency: "SAR", dueMinor: 50000 }],
      openings: [{ currency: "YER", remainingMinor: 100000 }],
      arrangements: [legacy({ arrangementRemainingMinor: 100000, overdueMinor: 60000 })],
      plans: [{ id: 4, title: "خطة تقويم", baseCurrency: "SAR", status: "active", installmentCount: 6,
        progress: { overdueMinor: 0, nextDueDate: TODAY, nextDueAmountMinor: 50000 } }],
      openInvoices: [],
    });
    expect(lines.map((line) => line.currency)).toEqual(["YER", "SAR"]);
    expect(arrivalSuggestions(lines)).toEqual([
      expect.objectContaining({ kind: "legacy", currency: "YER", amountMinor: 60000 }),
      expect.objectContaining({ kind: "plan", currency: "SAR", amountMinor: 50000, planId: 4 }),
    ]);
  });

  it("a future installment is not due today; a credit is shown as credit; nothing owed shows nothing", () => {
    const lines = buildArrivalCurrencyLines({
      today: TODAY,
      balances: [{ currency: "YER", dueMinor: -5000 }],
      openings: [],
      arrangements: [],
      plans: [{ id: 5, title: "خطة", baseCurrency: "YER", status: "active", installmentCount: 3,
        progress: { overdueMinor: 0, nextDueDate: "2026-11-01", nextDueAmountMinor: 20000 } }],
      openInvoices: [],
    });
    expect(lines).toEqual([expect.objectContaining({ currency: "YER", balanceMinor: -5000, planInstallments: [] })]);
    expect(arrivalSuggestions(lines)).toEqual([]);
    expect(buildArrivalCurrencyLines({ today: TODAY, balances: [], openings: [], arrangements: [], plans: [], openInvoices: [] })).toEqual([]);
  });

  it("the legacy suggestion never exceeds the remaining old balance", () => {
    const lines = buildArrivalCurrencyLines({
      today: TODAY,
      balances: [{ currency: "YER", dueMinor: 10000 }],
      openings: [{ currency: "YER", remainingMinor: 10000 }],
      arrangements: [legacy({ suggestedMinor: 30000, arrangementRemainingMinor: 10000 })],
      plans: [], openInvoices: [],
    });
    expect(arrivalSuggestions(lines)[0].amountMinor).toBe(10000);
  });
});

describe("(P0-D) wiring", () => {
  it("the legacy suggestion opens the existing payment modal on opening_currency; no new payment engine", () => {
    const panel = readFileSync("components/ArrivalPanel.tsx", "utf8");
    expect(panel).toMatch(/<CollectPaymentModal/);
    expect(panel).toMatch(/presetOpeningCurrency=\{collect\.suggestion\?\.kind === "legacy"/);
    expect(panel).not.toMatch(/fetch\("\/api\/payments"/);
    expect(panel).toMatch(/الدفع بعد العلاج/);
  });

  it("both arrival buttons open the panel after a successful arrival; clearance stays optional", () => {
    expect(readFileSync("app/page.tsx", "utf8")).toMatch(/if \(ok && patientId\) setArrivalPatient\(patientId\)/);
    expect(readFileSync("app/appointments/page.tsx", "utf8")).toMatch(/setArrivalPatient\(item\.patientId\)/);
    expect(readFileSync("lib/arrival-panel-db.ts", "utf8")).not.toMatch(/require_clearance_before_call/);
  });
});
