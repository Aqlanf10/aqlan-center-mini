import { describe, expect, it } from "vitest";
import { isCanonicalClinicalPlans, type CanonicalClinicalPlans } from "../lib/canonical-plan-projection";
import { canonicalPlanPatientId } from "../lib/canonical-plan-reads";

const sample = (): CanonicalClinicalPlans => ({ projection: "patient-plan-clinical", clinicTimeZone: "Asia/Aden", patientId: 9, hasMore: false, plans: [{
  id: 1, title: "SYN plan", status: "active", startDate: "2024-02-29", createdAt: "2024-03-01T10:00:00Z", note: null,
  consentAt: null, consentBy: null, consentNote: null,
  items: [{ id: 2, serviceName: "SYN saved service", category: null, toothCode: 26, surfaces: "MO", quantity: 2,
    status: "planned", doneAt: null, note: null, plannedVisitNumber: null, sessionCount: null, sessionsCompleted: 0, doctorName: null, caseSite: null }],
}] });
describe("clinical plan DTO and query boundary", () => {
  it("accepts native clinical facts, including an absent target without inventing one", () => {
    const value = sample(); expect(isCanonicalClinicalPlans(value, 9)).toBe(true);
    expect(value.plans[0].items[0].sessionCount).toBeNull();
  });
  it.each(["0009", "9e0", "9.0", "0", "-1", "2147483648", "9007199254740992", "x"])("rejects an ambiguous or invalid patient id %s", raw => {
    expect(() => canonicalPlanPatientId(raw, new URLSearchParams())).toThrow();
  });
  it.each(["includeMoney=1", "patientId=2", "limit=0", "scope=all"])("rejects URL expansion %s", query => {
    expect(() => canonicalPlanPatientId("9", new URLSearchParams(query))).toThrow();
  });
  it("binds the DTO to its patient and exact projection", () => {
    expect(isCanonicalClinicalPlans(sample(), 10)).toBe(false);
    expect(isCanonicalClinicalPlans({ ...sample(), projection: "legacy" }, 9)).toBe(false);
  });
  it.each(["2023-02-29", "2024-02-30", "2024-13-01", "2024-01-00"])("rejects invalid recorded calendar date %s", day => {
    const value = sample(); value.plans[0].startDate = day; expect(isCanonicalClinicalPlans(value, 9)).toBe(false);
  });
  it("refuses duplicate plans or items rather than merging clinical records", () => {
    const value = sample(); value.plans.push(structuredClone(value.plans[0])); expect(isCanonicalClinicalPlans(value, 9)).toBe(false);
    const other = sample(); other.plans[0].items.push(structuredClone(other.plans[0].items[0])); expect(isCanonicalClinicalPlans(other, 9)).toBe(false);
  });
  it.each([NaN, Infinity, -1, 0.5])("rejects invalid clinical counters %s", count => {
    const value = sample(); value.plans[0].items[0].sessionsCompleted = count; expect(isCanonicalClinicalPlans(value, 9)).toBe(false);
  });
  it("rejects a legacy finance payload, missing fields and unknown status without pretending an empty record", () => {
    expect(isCanonicalClinicalPlans({ plans: [] }, 9)).toBe(false);
    const value = sample(); value.plans[0].status = "unknown" as never; expect(isCanonicalClinicalPlans(value, 9)).toBe(false);
  });
});

it.each([undefined, null, 3, "SYN/Unknown"]) ("rejects a missing or invalid clinic zone: %s", clinicTimeZone => { expect(isCanonicalClinicalPlans({ ...sample(), clinicTimeZone }, 9)).toBe(false); });
