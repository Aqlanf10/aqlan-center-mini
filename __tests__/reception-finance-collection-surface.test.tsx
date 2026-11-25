import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { username: string; role: string } }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => session.current }));
vi.mock("@/components/finance/QuickCollectModal", () => ({
  QuickCollectModal: ({ debtors }: { debtors: unknown[] }) => createElement("span", { "data-debtors": debtors.length }),
}));
vi.mock("@/components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
import FinancePage from "../app/finance/page";
import { receptionSettlementTargets } from "../lib/reception-settlement-targets";

describe("reception collection without a clinic-wide shift read", () => {
  it("renders the receipt action but no clinic-wide dashboard or debtor suggestions", () => {
    session.current = { username: "synthetic-desk", role: "reception" };
    const html = renderToStaticMarkup(createElement(FinancePage));
    expect(html).toContain("إصدار سند قبض");
    expect(html).toContain('data-debtors="0"');
    expect(html).not.toContain("النقد المتوقع بالصندوق");
    expect(html).not.toContain("مديونيات المرضى");
  });
  it("does not mount either finance surface when the principal is missing", () => {
    session.current = null;
    expect(renderToStaticMarkup(createElement(FinancePage))).toBe("");
  });
  it("limits the reception-specific data read to a selected patient and retains the canonical modal", () => {
    const source = readFileSync("app/finance/page.tsx", "utf8");
    const surface = source.slice(source.indexOf("function ReceptionCollection()"), source.indexOf("function ClinicFinancePage()"));
    expect(surface).toContain("/api/patients/");
    expect(surface).toContain("/ledger");
    expect(surface).toContain("CollectPaymentModal");
    expect(surface).toContain("receptionSettlementTargets(data)");
    expect(surface).toContain("openings={selected.openings ?? []}");
    expect(surface).toContain("/print/receipt/");
    for (const endpoint of ["/api/shifts", "/api/finance/debts", "/api/parties", "/api/plans"]) {
      expect(surface).not.toContain(endpoint);
    }
  });
});

describe("reception historical settlement targets", () => {
  it("excludes active historical agreements in all currencies without hiding current plans", () => {
    const plans = receptionSettlementTargets({ plans: [
      { id: 1, title: "old YER", status: "active", baseCurrency: "YER", legacy: true },
      { id: 2, title: "old SAR", status: "active", baseCurrency: "SAR", legacy: true },
      { id: 3, title: "old USD", status: "active", baseCurrency: "USD", legacy: true },
      { id: 4, title: "current", status: "active", baseCurrency: "SAR" },
      { id: 5, title: "closed", status: "completed", baseCurrency: "YER" },
    ] }).plans;
    expect(plans).toEqual([{ id: 4, title: "current", baseCurrency: "SAR" }]);
  });

  it("offers outstanding opening balances independently by currency and caps each at its due", () => {
    const result = receptionSettlementTargets({ plans: [], openings: [
      { currency: "YER", amountMinor: 1000 },
      { currency: "SAR", amountMinor: 700 },
      { currency: "USD", amountMinor: 250 },
    ], balances: { YER: { dueMinor: 400 }, SAR: { dueMinor: 1000 }, USD: { dueMinor: 0 } } });
    expect(result.openings).toEqual([
      { currency: "YER", dueMinor: 400 }, { currency: "SAR", dueMinor: 700 },
    ]);
  });

  it("does not offer an opening target without positive, valid, same-currency due evidence", () => {
    expect(receptionSettlementTargets({ plans: [], openings: [
      { currency: "YER", amountMinor: 500 },
      { currency: "SAR", amountMinor: -1 },
      { currency: "USD", amountMinor: 100 },
      { amountMinor: 100 },
    ], balances: { SAR: { dueMinor: 100 }, USD: { dueMinor: 1.5 } } }).openings).toEqual([]);
  });
});
