import { describe, expect, it } from "vitest";
import {
  commissionForPatient,
  commissionForPatientAtEventTime,
  type CommissionInvoice,
  type CommissionPolicy,
} from "../lib/commission";
import { parseDoctorCommissionConfig, validateDoctorCommissionConfigInput } from "../lib/doctor-permissions";

const invoice = (over: Partial<CommissionInvoice> = {}): CommissionInvoice => ({
  id: 1, netMinor: 10000, currency: "YER", createdAt: "2024-01-01T09:00:00.000Z",
  doctorShares: [{ doctorId: 7, amountMinor: 10000, currency: "YER" }],
  ...over,
});

describe("المحرّك الواحد بوقت الحدث (P0-1)", () => {
  it("نسبة ثابتة ⇒ مطابقٌ حرفيًّا للواجهة القديمة commissionForPatient", () => {
    const invoices = [invoice({ netMinor: 33333, doctorShares: [{ doctorId: 7, amountMinor: 33333, currency: "YER", labCostMinor: 7777 }] })];
    const legacy = commissionForPatient(invoices, { YER: 12345, SAR: 0, USD: 0 }, new Map([[7, 30]]));
    const eventTime = commissionForPatientAtEventTime(
      invoices,
      [{ invoiceId: 1, amount: 5000, sourceTime: "2024-02-01T00:00:00Z" }, { invoiceId: 1, amount: 7345, sourceTime: "2024-03-01T00:00:00Z" }],
      () => ({ percent: 30, config: null }),
    );
    expect(eventTime.get(7)).toEqual(legacy.get(7));
  });

  it("كل جزء بنسبة وقت دفعته", () => {
    const at = (iso: string): CommissionPolicy => ({ percent: iso < "2024-06-01" ? 40 : 50, config: null });
    const result = commissionForPatientAtEventTime(
      [invoice({ netMinor: 20000, doctorShares: [{ doctorId: 7, amountMinor: 20000, currency: "YER" }] })],
      [{ invoiceId: 1, amount: 10000, sourceTime: "2024-02-01T00:00:00Z" }, { invoiceId: 1, amount: 10000, sourceTime: "2024-07-01T00:00:00Z" }],
      (_doctor, iso) => at(iso),
    );
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 8000, earnedMinor: 9000 });
  });

  it("أساس «مفوتَر» في سياسة الفاتورة ⇒ المستحق = المفوتَر ولو لم يُقبض شيء", () => {
    const config = parseDoctorCommissionConfig({ defaultPercent: 20, basis: "invoiced", deductLabCost: false });
    const result = commissionForPatientAtEventTime([invoice()], [], () => ({ percent: 0, config }));
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 2000, earnedMinor: 2000 });
  });

  it("طبيبٌ بلا سياسة لا يُسقط غيره", () => {
    const result = commissionForPatientAtEventTime(
      [invoice({ doctorShares: [{ doctorId: 7, amountMinor: 5000, currency: "YER" }, { doctorId: 8, amountMinor: 5000, currency: "YER" }] })],
      [{ invoiceId: 1, amount: 10000, sourceTime: "2024-02-01T00:00:00Z" }],
      (doctor) => (doctor === 8 ? { percent: 40, config: null } : undefined),
    );
    expect(result.has(7)).toBe(false);
    expect(result.get(8)?.YER.earnedMinor).toBe(2000);
  });
});

describe("التحقّق من الإعداد المتقدّم قبل الحفظ", () => {
  const valid = { calculationMode: "percentage", defaultPercent: 30, categoryRates: { ortho: 35 } };
  it("يقبل الصحيح ويحذف rateHistory المرسل من العميل", () => {
    const checked = validateDoctorCommissionConfigInput({ ...valid, rateHistory: [{ effectiveDate: "2020-01-01" }] });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.rateHistory).toEqual([]);
  });
  it.each([
    [{ ...valid, defaultPercent: 150 }, "بين 0 و100"],
    [{ ...valid, defaultPercent: -1 }, "بين 0 و100"],
    [{ ...valid, defaultPercent: "30" }, "بين 0 و100"],
    [{ ...valid, categoryRates: { ortho: 101 } }, "ortho"],
    [{ ...valid, calculationMode: "fixed" }, "المبلغ الثابت"],
    [{ ...valid, fixedAmountPerVisitMinor: 5000 }, "المبلغ الثابت"],
    [{ ...valid, calculationMode: "weird" }, "غير معروفة"],
    [{ ...valid, basis: "whatever" }, "أساس"],
    [{ ...valid, deductLabCost: "yes" }, "الخصم"],
    [{ ...valid, customServiceRates: [{ serviceName: "", percent: 10 }] }, "اسم الخدمة"],
    ["not-an-object", "غير صالح"],
  ])("يرفض %j", (input, message) => {
    const checked = validateDoctorCommissionConfigInput(input);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.message).toContain(message);
  });
});
