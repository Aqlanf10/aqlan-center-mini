import { describe, expect, it } from "vitest";
import type { Invoice, Payment, TreatmentPlan, patientStatementSnapshot } from "../lib/db";
import { assemblePatientStatement, statementDueNowByCurrency, treatmentStatementRows } from "../lib/patient-statement-build";
import { emptyStatementEvidence, projectPatientStatement } from "../lib/patient-statement-projection";
import { SETTING_DEFAULTS } from "../lib/settings";

function fixture() {
  const invoice: Invoice = { id: 1, patientId: 17, patientName: "Synthetic", invoiceNumber: "SYN-INV", status: "open", totalMinor: 1000, discountMinor: 0, baseCurrency: "YER", note: "PRIVATE", createdAt: "2026-01-01T10:00:00Z", items: [] };
  const payment: Payment = { id: 1, patientId: 17, patientName: "Synthetic", receiptNumber: "SYN-REC", invoiceId: 1, planId: null, openingCurrency: null, shiftId: 7, kind: "payment", reversalOfId: null, amountMinor: 400, currency: "YER", exchangeRate: 1, baseAmountMinor: 400, baseCurrency: "YER", method: "cash", note: "PRIVATE", createdBy: "PRIVATE", createdAt: "2026-01-02T10:00:00Z" };
  const plan = { id: 9, patientId: 17, title: "علاج اصطناعي", status: "active", totalFromItems: false, baseCurrency: "YER", totalMinor: 1000, items: [], installments: [],
    approvedAgreement: { planId: 9, currency: "YER", totalMinor: 1000, paidMinor: 400, remainingMinor: 600, dueNowMinor: 100, invoiceId: 1, openingCurrency: null, available: true, sourceKind: "invoice" } } as unknown as TreatmentPlan;
  const snapshot = { ledger: { invoices: [invoice], payments: [payment], openings: [] }, planCurrencies: new Map([[9, { patientId: 17, currency: "YER" as const }]]), plans: [plan], historicalAgreements: [], statementEvidence: emptyStatementEvidence() } satisfies Awaited<ReturnType<typeof patientStatementSnapshot>>;
  const projected = projectPatientStatement({ patientId: 17, ...snapshot, evidence: snapshot.statementEvidence });
  return { snapshot, projected, plan, payment };
}
const patient = { fullName: "مريض اصطناعي", patientNumber: "SYN-17", phone: null };
describe("statement type assembly uses verified sources", () => {
  it("shows posted principal once, and exact due-now only with complete verified coverage", () => {
    const { snapshot, projected } = fixture();
    expect(statementDueNowByCurrency(snapshot, projected)).toEqual({ YER: 100, SAR: 0, USD: 0 });
    const document = assemblePatientStatement(patient, SETTING_DEFAULTS, snapshot, projected, { type: "summary" }, "synthetic");
    const account = document.sections.find(s => s.title === "ملخص الحساب حسب العملة")!;
    expect(account.rows[0]).toEqual(["ريال يمني", "1,000 ر.ي", "0 ر.ي", "400 ر.ي", "600 ر.ي"]);
    expect(document.sections.find(s => s.title === "المستحق الآن حسب العملة")!.rows[0][1]).toBe("100 ر.ي");
    snapshot.plans.push({ ...snapshot.plans[0], id: 10 });
    expect(statementDueNowByCurrency(snapshot, projected).YER).toBeNull();
  });
  it("never distributes unallocated patient cash into a treatment statement", () => {
    const { snapshot, plan, payment } = fixture();
    snapshot.ledger.payments.push({ ...payment, id: 2, receiptNumber: "UNALLOCATED", invoiceId: null, amountMinor: 200, baseAmountMinor: 200 });
    const projected = projectPatientStatement({ patientId: 17, ...snapshot, evidence: snapshot.statementEvidence });
    const rows = treatmentStatementRows(snapshot, projected, plan);
    expect(JSON.stringify(rows)).toContain("SYN-REC"); expect(JSON.stringify(rows)).not.toContain("UNALLOCATED");
    expect(statementDueNowByCurrency(snapshot, projected).YER).toBeNull();
    const document = assemblePatientStatement(patient, SETTING_DEFAULTS, snapshot, projected, { type: "treatment", treatmentId: 9 }, "synthetic");
    expect(document.sections[0].rows[0]).toContain("400 ر.ي");
    expect(JSON.stringify(document)).not.toContain("PRIVATE");
    expect(() => assemblePatientStatement(patient, SETTING_DEFAULTS, snapshot, projected, { type: "treatment", treatmentId: 18 }, "synthetic")).toThrow();
  });
  it("separates clinically finished debt and unknown sources from ongoing work", () => {
    const { snapshot, projected, plan } = fixture();
    snapshot.plans.push({ ...plan, id: 10, title: "منتهٍ ومدين", status: "completed" }, { ...plan, id: 11, title: "منتهٍ غير متحقق", status: "completed", approvedAgreement: null });
    const document = assemblePatientStatement(patient, SETTING_DEFAULTS, snapshot, projected, { type: "ongoing" }, "synthetic");
    expect(document.sections.find(s => s.title === "العلاج الجاري")!.rows.map(r => r[0])).toEqual(["علاج اصطناعي"]);
    expect(document.sections.find(s => s.title === "علاج منتهٍ سريريًا وبقيت عليه مديونية")!.rows.map(r => r[0])).toEqual(["منتهٍ ومدين"]);
    expect(document.sections.find(s => s.title.includes("الرصيد غير متاح"))!.rows.map(r => r[0])).toEqual(["منتهٍ غير متحقق"]);
  });
  it("period copies contain only that period's balances and no current agreement amounts", () => {
    const { snapshot } = fixture();
    const options = { type: "period" as const, from: "2026-01-02", to: "2026-01-02" };
    const projected = projectPatientStatement({ patientId: 17, ...snapshot, evidence: snapshot.statementEvidence }, options);
    const document = assemblePatientStatement(patient, SETTING_DEFAULTS, snapshot, projected, options, "synthetic");
    expect(document.sections[0].rows[0]).toEqual(["ريال يمني", "1,000 ر.ي", "600 ر.ي"]);
    expect(JSON.stringify(document.sections)).not.toContain("علاج اصطناعي");
  });
});
