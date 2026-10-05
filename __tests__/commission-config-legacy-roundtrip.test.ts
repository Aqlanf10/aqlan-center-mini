import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCTOR_COMMISSION_CONFIG, parseDoctorCommissionConfig,
  validateDoctorCommissionConfigInput, type DoctorCommissionConfig, type RateHistoryEntry,
} from "../lib/doctor-permissions";
import {
  commissionForPatientAtEventTime, findServiceRate, resolveDoctorEffectivePolicy,
  resolveLegacyServiceRateNames, resolvePolicyForShare, type CommissionDetailLine,
  type ServiceRateFinding,
} from "../lib/commission";

const legacyRates = { "7": 61.25, "007": 23.5, "  Mixed  NAME  ": 12.345, "zero service": 0 };
function legacyConfig(overrides: Partial<DoctorCommissionConfig> = {}): DoctorCommissionConfig {
  return {
    calculationMode: "by_category", defaultPercent: 17,
    categoryRates: { endo: 72, filling: 0, custom_raw: 12.345 }, serviceRates: { ...legacyRates },
    fixedAmountPerVisitMinor: 0, deductLabCost: false, deductMaterialCost: false,
    basis: "collected_cash", effectiveDate: "2024-01-01", rateHistory: [], ...overrides,
  };
}
function roundTrips(raw: unknown): DoctorCommissionConfig[] {
  const once = parseDoctorCommissionConfig(raw);
  const twice = parseDoctorCommissionConfig(once);
  const serialized = parseDoctorCommissionConfig(JSON.stringify(once));
  return [once, twice, serialized, parseDoctorCommissionConfig(JSON.stringify(serialized))];
}
function expectLegacyMap(config: DoctorCommissionConfig, rates: Record<string, number> = legacyRates) {
  expect(Object.hasOwn(config, "customServiceRates")).toBe(false);
  expect(Object.hasOwn(JSON.parse(JSON.stringify(config)), "customServiceRates")).toBe(false);
  expect(config.serviceRates).toStrictEqual(rates);
}
function validate(raw: unknown): DoctorCommissionConfig {
  const checked = validateDoctorCommissionConfigInput(raw);
  if (!checked.ok) throw new Error(checked.message);
  return checked.value;
}

describe("legacy commission map round trips", () => {
  it.each(["object", "json"] as const)("preserves a map-only %s without mutating input or defaults", kind => {
    const raw = legacyConfig();
    const original = JSON.stringify(raw);
    const defaults = JSON.stringify(DEFAULT_DOCTOR_COMMISSION_CONFIG);
    Object.freeze(raw.serviceRates);
    Object.freeze(raw.categoryRates);
    Object.freeze(raw.rateHistory);
    Object.freeze(raw);
    const stages = roundTrips(kind === "json" ? original : raw);
    expect(stages[1].serviceRates).toStrictEqual(legacyRates);
    expect(findServiceRate(stages[2], 7, "anything")?.percent).toBe(61.25);
    for (const config of stages) {
      expectLegacyMap(config);
      expect(config).toStrictEqual(stages[0]);
      expect(config.categoryRates).toMatchObject(raw.categoryRates);
      expect(config.defaultPercent).toBe(17);
      expect(config.effectiveDate).toBe("2024-01-01");
    }
    expect(stages[0].serviceRates).not.toBe(raw.serviceRates);
    expect(JSON.stringify(raw)).toBe(original);
    expect(JSON.stringify(DEFAULT_DOCTOR_COMMISSION_CONFIG)).toBe(defaults);
  });

  it.each([0, 12.345])("preserves rates across the Users API/editor serialization contract with general rate %s", percent => {
    const stored = JSON.stringify(legacyConfig());
    // listUsers projects the stored JSON; GET serializes it; openEditor parses it again.
    // This models those pure boundaries, without importing the DB or rendering the UI.
    const response = JSON.parse(JSON.stringify([{ commissionConfig: parseDoctorCommissionConfig(stored) }]));
    const projected: DoctorCommissionConfig = response[0].commissionConfig;
    const draft = parseDoctorCommissionConfig(projected);
    expect(draft.serviceRates).toStrictEqual(legacyRates);
    expectLegacyMap(projected);
    // PR244's separate read-only guard must still recognize the preserved legacy map.
    expect(Object.keys(projected.serviceRates ?? {}).length > 0 && !projected.customServiceRates?.length).toBe(true);
    expectLegacyMap(draft);
    // A caller's submitted advanced config is strictly validated and serialized before re-reading.
    // This does not imply that PR244 permits editing this read-only policy in the UI.
    const payload = JSON.parse(JSON.stringify({ ...draft, defaultPercent: percent }));
    const saved = JSON.stringify(validate(payload));
    for (const config of roundTrips(saved)) {
      expectLegacyMap(config);
      expect(resolveDoctorEffectivePolicy(config, "2024-06-01", "rct"))
        .toMatchObject({ percent, matchedRule: "default" });
      expect(resolveDoctorEffectivePolicy(config, "2024-06-01", "endo"))
        .toMatchObject({ percent: 72, matchedRule: "category" });
      expect(resolveDoctorEffectivePolicy(config, "2024-06-01", "filling"))
        .toMatchObject({ percent: 0, matchedRule: "category" });
      expect(resolveDoctorEffectivePolicy(config, "2024-06-01", "custom_raw"))
        .toMatchObject({ percent: 12.345, matchedRule: "category" });
      expect(findServiceRate(config, 7, "anything")?.percent).toBe(61.25);
      expect(findServiceRate(config, undefined, "mixed name")?.percent).toBe(12.345);
      expect(findServiceRate(config, undefined, "zero service")?.percent).toBe(0);
      expect(findServiceRate(config, undefined, "mixed name extra")).toBeUndefined();
      expect(validate(JSON.parse(JSON.stringify(config)))).toStrictEqual(config);
      const editedCategory = validate({ ...config, categoryRates: { ...config.categoryRates, custom_raw: 0 } });
      expectLegacyMap(parseDoctorCommissionConfig(JSON.stringify(editedCategory)));
      expect(editedCategory.categoryRates.custom_raw).toBe(0);
    }
  });

  it("retains an empty legacy map without inventing a modern list", () => {
    for (const config of roundTrips(legacyConfig({ serviceRates: {} }))) expectLegacyMap(config, {});
  });

  it.each([undefined, null, "invalid", {}])("keeps permissive non-array reads and strict validation separate: %j", customServiceRates => {
    const raw = { ...legacyConfig(), customServiceRates };
    for (const config of roundTrips(raw)) expectLegacyMap(config);
    expect(validateDoctorCommissionConfigInput(raw).ok).toBe(customServiceRates === undefined);
    expect(Object.hasOwn(raw, "customServiceRates")).toBe(true);
    if (customServiceRates === undefined) expectLegacyMap(validate(raw));
  });

  it("keeps legacy clamping/filtering without loosening write validation", () => {
    const raw = { ...legacyConfig(), serviceRates: { zero: 0, fractional: 12.345, low: -1, high: 101, bad: "30", infinite: Infinity } };
    for (const config of roundTrips(raw)) expectLegacyMap(config, { zero: 0, fractional: 12.345, low: 0, high: 100 });
    expect(validateDoctorCommissionConfigInput(raw).ok).toBe(false);
  });

  it("copies only own enumerable legacy map keys", () => {
    const rates = Object.create({ inherited_service: 90 }) as Record<string, number>;
    Object.assign(rates, { own_service: 12.345, constructor: 13.125, toString: 14.5 });
    for (const config of roundTrips(legacyConfig({ serviceRates: rates }))) {
      expectLegacyMap(config, { own_service: 12.345, constructor: 13.125, toString: 14.5 });
      expect(findServiceRate(config, undefined, "inherited_service")).toBeUndefined();
      expect(findServiceRate(config, undefined, "constructor")?.percent).toBe(13.125);
      expect(findServiceRate(config, undefined, "tostring")?.percent).toBe(14.5);
    }
  });

  it.each(["7", "007"])("preserves numeric raw key %s and the existing direct/report distinction", key => {
    for (const config of roundTrips(legacyConfig({ serviceRates: { [key]: 61.25 } }))) {
      expectLegacyMap(config, { [key]: 61.25 });
      expect(findServiceRate(config, undefined, key)).toBeUndefined();
      expect(findServiceRate(config, 8, key)).toBeUndefined();
      expect(findServiceRate(config, 7, "anything")?.percent).toBe(key === "7" ? 61.25 : undefined);
      const before = JSON.stringify(config);
      const findings: ServiceRateFinding[] = [];
      const report = resolveLegacyServiceRateNames(config, [], 7, findings);
      expect(findServiceRate(report, 7, "anything")?.percent).toBe(61.25);
      expect(findServiceRate(report, undefined, key)?.percent).toBe(61.25);
      expect(findings).toStrictEqual([]);
      expect(JSON.stringify(config)).toBe(before);
    }
  });
});

describe("explicit modern arrays remain authoritative", () => {
  it.each(["object", "json"] as const)("never resurrects a stale map with explicit [] in %s input", kind => {
    const raw = legacyConfig({ customServiceRates: [] });
    const original = JSON.stringify(raw);
    for (const config of roundTrips(kind === "json" ? original : raw)) {
      expect(config.customServiceRates).toStrictEqual([]);
      expect(config.serviceRates).toStrictEqual({});
      expect(findServiceRate(config, 7, "mixed name")).toBeUndefined();
    }
    // Identical stored [] + map bytes have no provenance; no recovery is inferred.
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("keeps modern ID/name authority and deliberate last-rule removal", () => {
    const raw = legacyConfig({ customServiceRates: [{ id: "modern", serviceId: 7, serviceName: "Modern Service", percent: 25.125 }] });
    for (const config of roundTrips(raw)) {
      expect(config.customServiceRates).toHaveLength(1);
      expect(config.serviceRates).toStrictEqual({ "7": 25.125, "modern service": 25.125 });
      expect(findServiceRate(config, 7, "anything")?.percent).toBe(25.125);
      expect(findServiceRate(config, 8, "Modern Service")).toBeUndefined();
      expect(findServiceRate(config, undefined, "Modern Service")?.percent).toBe(25.125);
      expect(findServiceRate(config, undefined, "mixed name")).toBeUndefined();
    }
    const removed = validate({ ...parseDoctorCommissionConfig(raw), customServiceRates: [], serviceRates: {} });
    for (const config of roundTrips(removed)) {
      expect(config.customServiceRates).toStrictEqual([]);
      expect(config.serviceRates).toStrictEqual({});
      expect(findServiceRate(config, 7, "Modern Service")).toBeUndefined();
    }
  });

  it("does not fall back to the stale map when an invalid modern list normalizes to []", () => {
    const raw = { ...legacyConfig(), customServiceRates: [{ serviceName: "", percent: 30 }] };
    for (const config of roundTrips(raw)) {
      expect(config.customServiceRates).toStrictEqual([]);
      expect(config.serviceRates).toStrictEqual({});
    }
    expect(validateDoctorCommissionConfigInput(raw).ok).toBe(false);
  });
});

describe("defaults, historical entries and event calculations stay unchanged", () => {
  it.each([undefined, null, "", "null", "  null  ", "{invalid", 0, false])("retains the default projection for %j", raw => {
    const config = parseDoctorCommissionConfig(raw);
    expect(config.defaultPercent).toBe(DEFAULT_DOCTOR_COMMISSION_CONFIG.defaultPercent);
    expect(config.categoryRates).toStrictEqual(DEFAULT_DOCTOR_COMMISSION_CONFIG.categoryRates);
    expect(config.categoryRates).not.toBe(DEFAULT_DOCTOR_COMMISSION_CONFIG.categoryRates);
    expect(config.customServiceRates).toStrictEqual([]);
    expect(config.serviceRates).toStrictEqual({});
    expect(config.rateHistory).toStrictEqual([]);
  });

  it("preserves null-policy zero/fraction rates and the existing positive-only parser fallback", () => {
    for (const percent of [0, 12.345]) {
      expect(resolvePolicyForShare({ percent, config: null }, "2024-06-01", {}))
        .toMatchObject({ percent, ruleSource: "default", basis: "collected_cash" });
    }
    expect(parseDoctorCommissionConfig(null, 20).defaultPercent).toBe(20);
    expect(parseDoctorCommissionConfig(null, 0).defaultPercent).toBe(DEFAULT_DOCTOR_COMMISSION_CONFIG.defaultPercent);
  });

  it.each([undefined, null, false, "invalid"])("retains defaults when no legacy map is readable: %j", serviceRates => {
    const config = parseDoctorCommissionConfig({ ...legacyConfig(), serviceRates });
    expect(config.customServiceRates).toStrictEqual([]);
    expect(config.serviceRates).toStrictEqual({});
  });

  it.each(["absent", "empty"] as const)("does not reinterpret embedded history with an %s list", kind => {
    const entry: RateHistoryEntry = {
      id: "historic", effectiveDate: "2020-01-01", calculationMode: "percentage",
      defaultPercent: 9, categoryRates: {}, serviceRates: { "7": 61.25 },
      fixedAmountPerVisitMinor: 0, deductLabCost: false, deductMaterialCost: false,
      basis: "invoiced", updatedAt: "2020-01-01T00:00:00Z", updatedBy: "synthetic",
      ...(kind === "empty" ? { customServiceRates: [] } : {}),
    };
    const raw = legacyConfig({ customServiceRates: [], rateHistory: [entry] });
    const original = JSON.stringify(raw);
    for (const config of roundTrips(raw)) {
      expect(config.customServiceRates).toStrictEqual([]);
      expect(config.serviceRates).toStrictEqual({});
      expect(config.rateHistory).toStrictEqual([entry]);
      expect(Object.hasOwn(config.rateHistory[0], "customServiceRates")).toBe(kind === "empty");
      expect(resolveDoctorEffectivePolicy(config, "2021-01-01", undefined, { serviceId: 7 }))
        .toMatchObject({ percent: 61.25, matchedRule: "custom_service", basis: "invoiced" });
    }
    expect(JSON.stringify(raw)).toBe(original);
    expect(validate(raw).rateHistory).toStrictEqual([]);
    expect(validate(raw).serviceRates).toStrictEqual({});
  });

  it.each(["collected_cash", "invoiced"] as const)("retains exact zero/fraction service results on %s", basis => {
    for (const config of roundTrips(legacyConfig({ basis }))) {
      const lines: CommissionDetailLine[] = [];
      const totals = commissionForPatientAtEventTime([{
        id: 1, netMinor: 200000, currency: "YER", createdAt: "2024-06-01T09:00:00Z",
        doctorShares: [
          { doctorId: 7, amountMinor: 100000, currency: "YER", serviceName: "mixed name" },
          { doctorId: 8, amountMinor: 100000, currency: "YER", serviceName: "zero service" },
        ],
      }], [{ invoiceId: 1, amount: 200000, sourceTime: "2024-06-02T09:00:00Z" }],
      () => ({ percent: 20, config }), undefined, { sink: line => lines.push(line) });
      expect(totals.get(7)?.YER).toStrictEqual({ accruedMinor: 12345, earnedMinor: 12345 });
      expect(totals.has(8)).toBe(false);
      expect(lines.find(line => line.doctorId === 8)).toMatchObject({
        percent: 0, ruleSource: "custom_service", accruedMinor: 0, earnedMinor: 0,
      });
    }
  });
});
