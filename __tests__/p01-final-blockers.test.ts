import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  patientBalancesByCurrency,
  settlementTargetCurrency,
} from "../lib/money";

describe("P-01 final blockers: legacy refund target", () => {
  it("unlinked legacy SAR refund stays in the SAR bucket", () => {
    const balances = patientBalancesByCurrency(
      [{ totalMinor: 20_000, discountMinor: 0, status: "open", baseCurrency: "SAR" }],
      [{
        amountMinor: 5_000,
        currency: "SAR",
        exchangeRate: 130,
        baseAmountMinor: 650_000,
        kind: "refund",
        invoiceCurrency: null,
      }],
      0,
    );

    expect(balances.SAR.billedMinor).toBe(20_000);
    expect(balances.SAR.collectedMinor).toBe(-5_000);
    expect(balances.SAR.dueMinor).toBe(25_000);
    expect(balances.YER.dueMinor).toBe(0);
  });

  it("unlinked refunds use their own currency while ordinary on-account payments stay base", () => {
    expect(settlementTargetCurrency({ kind: "refund", currency: "USD" }, null)).toBe("USD");
    expect(settlementTargetCurrency({ kind: "refund", currency: "SAR" }, null)).toBe("SAR");
    expect(settlementTargetCurrency({ kind: "payment", currency: "SAR" }, null)).toBe("YER");
  });

  it("an explicitly resolved invoice/plan target always wins", () => {
    expect(settlementTargetCurrency({ kind: "refund", currency: "SAR" }, "USD")).toBe("USD");
    expect(settlementTargetCurrency({ kind: "payment", currency: "USD" }, "SAR")).toBe("SAR");
  });
});

describe("P-01 final blockers: foreign quick collection wiring", () => {
  it("finance page preserves currency and loads an explicit settlement target", () => {
    const source = readFileSync("app/finance/page.tsx", "utf8");
    expect(source).toContain("void openCollectForPatient(p);");
    expect(source).toContain("/api/patients/${patient.id}/ledger");
    expect(source).toContain("suggestedCurrency={selectedCollectPatient.currency}");
    expect(source).toContain("invoices={selectedCollectPatient.invoices ?? []}");
    expect(source).toContain("plans={selectedCollectPatient.plans ?? []}");
    expect(source).toContain("presetInvoice={selectedCollectPatient.presetInvoice ?? null}");
  });

  it("payment modal refuses foreign collection without invoice/plan target", () => {
    const source = readFileSync("components/CollectPaymentModal.tsx", "utf8");
    expect(source).toContain("const missingForeignTarget = currency !== base && !invoiceId && !planId;");
    expect(source).toContain("disabled={busy || !amount.trim() || missingForeignTarget}");
    expect(source).toContain("يتطلب اختيار فاتورة أو خطة بنفس عملة الاتفاق");
  });

  it("all read paths share the same unlinked-refund target rule", () => {
    const reports = readFileSync("lib/reports.ts", "utf8");
    const db = readFileSync("lib/db.ts", "utf8");
    expect(reports).toContain("settlementTargetCurrency(");
    expect(db).toContain("settlementTargetCurrency({ kind: row.kind, currency }, null)");
  });
});
