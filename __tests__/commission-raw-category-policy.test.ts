import { describe, expect, it } from "vitest";
import { commissionForPatientAtEventTime, resolveDoctorEffectivePolicy, type CommissionDetailLine } from "../lib/commission";
import { parseDoctorCommissionConfig, validateDoctorCommissionConfigInput } from "../lib/doctor-permissions";

const config = () => parseDoctorCommissionConfig({ calculationMode: "by_category", defaultPercent: 17, categoryRates: {}, basis: "invoiced" });
const keys = ["constructor", "toString", "__proto__"];

describe("raw category policies only use own finite numeric rates", () => {
  it.each(keys)("inherits the actual default for the legitimate raw key %s", key => {
    const policy = config();
    expect(Object.hasOwn(policy.categoryRates, key)).toBe(false);
    expect(resolveDoctorEffectivePolicy(policy, "2026-10-04", key)).toMatchObject({ percent: 17, matchedRule: "default" });
    const lines: CommissionDetailLine[] = [];
    const totals = commissionForPatientAtEventTime([{ id: 1, netMinor: 10000, currency: "YER", createdAt: "2026-10-04T10:00:00Z",
      doctorShares: [{ doctorId: 7, amountMinor: 10000, currency: "YER", category: key }] }], [], () => ({ percent: 20, config: policy }), undefined, { sink: line => lines.push(line) });
    expect(totals.get(7)?.YER).toEqual({ accruedMinor: 1700, earnedMinor: 1700 });
    expect(lines[0]).toMatchObject({ category: key, percent: 17, ruleSource: "default", accruedMinor: 1700, earnedMinor: 1700 });
  });
  it.each([0, 42])("retains JSON __proto__ as an own numeric policy, including %i", percent => {
    const raw = `{"calculationMode":"by_category","defaultPercent":17,"categoryRates":{"__proto__":${percent}}}`;
    const parsed = parseDoctorCommissionConfig(raw);
    expect(Object.hasOwn(parsed.categoryRates, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed.categoryRates)).toBe(Object.prototype);
    expect(resolveDoctorEffectivePolicy(parsed, "2026-10-04", "__proto__")).toMatchObject({ percent, matchedRule: "category" });
    const checked = validateDoctorCommissionConfigInput(JSON.parse(raw));
    if (!checked.ok) throw new Error(checked.message);
    expect(Object.hasOwn(checked.value.categoryRates, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(checked.value.categoryRates))["__proto__"]).toBe(percent);
    expect(JSON.parse(raw).categoryRates["__proto__"]).toBe(percent);
  });
  it("uses the actual cash basis for a prototype-named raw key with partial payment", () => {
    const policy = config(); policy.basis = "collected_cash";
    const totals = commissionForPatientAtEventTime([{ id: 1, netMinor: 10000, currency: "YER", createdAt: "2024-06-10T06:00:00Z",
      doctorShares: [{ doctorId: 7, amountMinor: 10000, currency: "YER", category: "constructor" }] }],
    [{ invoiceId: 1, amount: 5000, sourceTime: "2024-06-10T06:00:00Z" }], () => ({ percent: 20, config: policy }));
    expect(totals.get(7)?.YER).toEqual({ accruedMinor: 1700, earnedMinor: 850 });
  });
  it.each(keys)("resolves an explicitly saved own %s rate, including zero", key => {
    for (const percent of [0, 42]) {
      const parsed = parseDoctorCommissionConfig(JSON.stringify({ calculationMode: "by_category", defaultPercent: 17, categoryRates: { [key]: percent } }));
      expect(Object.hasOwn(parsed.categoryRates, key)).toBe(true);
      expect(Object.getPrototypeOf(parsed.categoryRates)).toBe(Object.prototype);
      expect(resolveDoctorEffectivePolicy(parsed, "2026-10-04", key)).toMatchObject({ percent, matchedRule: "category" });
    }
  });
  it.each([NaN, Infinity, "42", null, undefined, () => 42])("rejects an own nonnumeric or nonfinite rate %s", value => {
    const policy = config(); policy.categoryRates = { custom_raw: value } as unknown as Record<string, number>;
    expect(resolveDoctorEffectivePolicy(policy, "2026-10-04", "custom_raw")).toMatchObject({ percent: 17, matchedRule: "default" });
  });
  it("does not inherit arbitrary prototype rates and preserves a zero general rate", () => {
    const policy = config(); policy.defaultPercent = 0; policy.categoryRates = Object.create({ custom_raw: 88 });
    expect(resolveDoctorEffectivePolicy(policy, "2026-10-04", "custom_raw")).toMatchObject({ percent: 0, matchedRule: "default" });
  });
  it("keeps normal/legacy keys independent and special services above an explicit raw category zero", () => {
    const policy = parseDoctorCommissionConfig({ calculationMode: "by_category", defaultPercent: 17,
      categoryRates: { constructor: 0, endo: 72, custom_raw: 41, filling: 49 },
      customServiceRates: [{ id: "specific", serviceId: 7, serviceName: "خدمة خاصة", percent: 83 }] });
    for (const [key, percent, matchedRule] of [["constructor", 0, "category"], ["endo", 72, "category"], ["rct", 17, "default"],
      ["custom_raw", 41, "category"], ["filling", 49, "category"], ["unknown_raw", 17, "default"]] as const) {
      expect(resolveDoctorEffectivePolicy(policy, "2026-10-04", key)).toMatchObject({ percent, matchedRule });
    }
    expect(resolveDoctorEffectivePolicy(policy, "2026-10-04", "constructor", { serviceId: 7 })).toMatchObject({ percent: 83, matchedRule: "custom_service" });
  });
  it("reads an existing historical own raw policy without rewriting its stored JSON", () => {
    const raw = '{"calculationMode":"by_category","defaultPercent":17,"categoryRates":{},"rateHistory":[{"effectiveDate":"2020-01-01","calculationMode":"by_category","defaultPercent":7,"categoryRates":{"__proto__":61},"basis":"invoiced","deductLabCost":false,"deductMaterialCost":false}]}';
    const source = JSON.parse(raw); const before = JSON.stringify(source);
    const parsed = parseDoctorCommissionConfig(source);
    expect(resolveDoctorEffectivePolicy(parsed, "2021-01-01", "__proto__")).toMatchObject({ percent: 61, matchedRule: "category" });
    expect(JSON.stringify(source)).toBe(before);
  });
});
