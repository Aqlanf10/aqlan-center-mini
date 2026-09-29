import { describe, expect, it } from "vitest";
import { attributeInstallment } from "@/lib/plans";

/** (DOCATTR-1 — D1) القسط يُنسب إلى أطباء بنود خطته بنسبة القيمة، والمجموع لا يزيد ولا ينقص فلسًا. */
describe("attributeInstallment", () => {
  it("splits by item value across doctors and keeps the exact total", () => {
    const lines = attributeInstallment(100_000, [
      { doctorId: 1, serviceId: 10, serviceName: "تقويم", valueMinor: 600_000 },
      { doctorId: 2, serviceId: 20, serviceName: "علاج عصب", valueMinor: 300_000 },
      { doctorId: 1, serviceId: 10, serviceName: "تقويم", valueMinor: 100_000 },
    ], 9);
    expect(lines).toEqual([
      { doctorId: 1, serviceId: 10, serviceName: "تقويم", amountMinor: 70_000 },
      { doctorId: 2, serviceId: 20, serviceName: "علاج عصب", amountMinor: 30_000 },
    ]);
  });

  it("largest remainder: the parts always sum to the installment", () => {
    const lines = attributeInstallment(100, [
      { doctorId: 1, serviceId: 1, serviceName: "أ", valueMinor: 1 },
      { doctorId: 2, serviceId: 2, serviceName: "ب", valueMinor: 1 },
      { doctorId: 3, serviceId: 3, serviceName: "ج", valueMinor: 1 },
    ], null);
    expect(lines.map((line) => line.amountMinor)).toEqual([34, 33, 33]);
    expect(lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(100);
  });

  it("an item without a doctor goes to the plan's primary doctor", () => {
    expect(attributeInstallment(50_000, [
      { doctorId: null, serviceId: 5, serviceName: "تقويم", valueMinor: 1 },
    ], 7)).toEqual([{ doctorId: 7, serviceId: 5, serviceName: "تقويم", amountMinor: 50_000 }]);
  });

  it("no valued items ⇒ one line for the primary doctor (or none, as before)", () => {
    expect(attributeInstallment(50_000, [], 7)).toEqual([{ doctorId: 7, serviceId: null, serviceName: null, amountMinor: 50_000 }]);
    expect(attributeInstallment(50_000, [{ doctorId: 1, serviceId: 1, serviceName: "x", valueMinor: 0 }], null))
      .toEqual([{ doctorId: null, serviceId: null, serviceName: null, amountMinor: 50_000 }]);
  });
});
