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
    expect(surface).toContain("/print/receipt/");
    for (const endpoint of ["/api/shifts", "/api/finance/debts", "/api/parties", "/api/plans"]) {
      expect(surface).not.toContain(endpoint);
    }
  });
});
