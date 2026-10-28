import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/debt-repayment-agreement-db", () => ({ readSavedRepaymentAgreement: mocks.read }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
import { DebtRepaymentAgreementPrint } from "../components/DebtRepaymentAgreementPrint";
import { debtInstallmentProgress } from "../lib/debt-installments";

describe("saved repayment contract presentation", () => {
  const today = "2026-10-28";
  function fixture() {
    const installments = [
      { amountMinor: 10000, dueDate: "2026-10-01", kind: "installment" as const },
      { amountMinor: 10000, dueDate: "2026-10-15", kind: "installment" as const },
      { amountMinor: 10000, dueDate: "2026-11-15", kind: "installment" as const },
    ];
    return {
      source: { invoice_number: "SYN-PRINT", full_name: "مريض اصطناعي", patient_number: "SYN-1", phone: null },
      settings: { "clinic.name": "مركز اصطناعي" },
      schedule: {
        id: 1, version: 2, target: { currency: "SAR" }, principalMinor: 50000,
        collectedMinor: 35000, remainingMinor: 15000, revisionPrincipalMinor: 30000,
        terms: { installments },
        progress: debtInstallmentProgress({ principalMinor: 30000, currentRemainingMinor: 15000, netSettledSinceRevisionMinor: 15000, installments, today }),
      },
    };
  }
  beforeEach(() => { mocks.read.mockResolvedValue(fixture()); });
  it("renders canonical allocations, distinct lifetime summary and revision explanation", async () => {
    const html = renderToStaticMarkup(await DebtRepaymentAgreementPrint({ id: 1, version: 2, today }));
    expect(mocks.read).toHaveBeenCalledWith(1, 2, today);
    expect(html).toContain("إجمالي الفاتورة");
    expect(html).toContain("المبلغ المتبقي الذي جرى جدولته عند الاعتماد");
    expect(html).toContain("وليس مبلغًا إضافيًا");
    expect(html).toContain("المقدمة المقترحة موعد سداد وليست سند قبض");
    expect(html).toContain('data-payment-status="paid"');
    expect(html).toContain("مسدد بالكامل");
    expect(html).toContain("مسدد جزئيًا · متأخر");
    expect(html).toContain("غير مسدد · لم يحل موعده");
    expect(html).toContain('dateTime="2026-11-15"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
  });
  it("labels opening balances without falsely calling them an invoice", async () => {
    const data = fixture(); data.source.invoice_number = ""; mocks.read.mockResolvedValue(data);
    const html = renderToStaticMarkup(await DebtRepaymentAgreementPrint({ id: 1, version: 2, today }));
    expect(html).toContain("قيمة الرصيد السابق"); expect(html).not.toContain("إجمالي الفاتورة");
  });
  it("retains refusal of stale or unavailable agreements", async () => {
    mocks.read.mockResolvedValue(null);
    await expect(DebtRepaymentAgreementPrint({ id: 1, version: 2, today })).rejects.toThrow("NOT_FOUND");
  });
});
