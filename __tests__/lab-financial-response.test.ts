import { describe, expect, it } from "vitest";
import { projectLabOrderResponse, projectLabTrackingEvents } from "../lib/lab-response";
import { clinicalOrder, financialFields, financialKinds, fullOrder, trackingEvents } from "./fixtures/lab-financial-response";

const serialized = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("pure lab financial response containment", () => {
  it("preserves all clinical values, omits every financial key except compatibility nulls, and never mutates", () => {
    const original = structuredClone(fullOrder);
    const frozen = Object.freeze({ ...fullOrder, futureFinancialSecret: "FUTURE-FINANCIAL-SENTINEL" });
    const result = projectLabOrderResponse(frozen, false);
    expect(serialized(result)).toEqual({ ...clinicalOrder, costMinor: null, costCurrency: null });
    for (const key of Object.keys(financialFields)) {
      if (key !== "costMinor" && key !== "costCurrency") expect(result).not.toHaveProperty(key);
    }
    expect(result).not.toHaveProperty("futureFinancialSecret");
    expect(fullOrder).toEqual(original);
    expect(frozen).toEqual({ ...original, futureFinancialSecret: "FUTURE-FINANCIAL-SENTINEL" });
    expect(result).not.toBe(frozen);
  });
  it("returns financially allowed canonical DTOs unchanged, including future keys and embedded history", () => {
    const original = { ...fullOrder, futureFinancialSecret: "future", events: trackingEvents };
    expect(projectLabOrderResponse(original, true)).toBe(original);
  });
  it("retains clinical-only legacy DTOs with cost nulls without invented finance values", () => {
    const legacy = { ...clinicalOrder, costMinor: null, costCurrency: null };
    expect(serialized(projectLabOrderResponse(legacy, false))).toEqual(legacy);
    expect(projectLabOrderResponse(legacy, true)).toBe(legacy);
  });
  it("filters optional embedded history by the same decision without mutating the source", () => {
    const original = { ...fullOrder, events: trackingEvents };
    const before = structuredClone(original);
    expect(projectLabOrderResponse(original, false).events).toEqual(
      trackingEvents.filter(event => !financialKinds.includes(event.action)),
    );
    expect(original).toEqual(before);
  });
  it("filters only known financial event kinds and preserves clinical ordering, values and unclassified notes", () => {
    const original = structuredClone(trackingEvents);
    original[0].notes = "A clinical note may mention an account; free text is not heuristically rewritten";
    const before = structuredClone(original);
    const result = projectLabTrackingEvents(original, false);
    expect(result).toEqual(original.filter(event => !financialKinds.includes(event.action)));
    expect(result[0]).toBe(original[0]);
    expect(JSON.stringify(result)).not.toContain("FINANCIAL-EVENT-");
    expect(original).toEqual(before);
    expect(projectLabTrackingEvents(original, true)).toBe(original);
    expect(projectLabTrackingEvents([], false)).toEqual([]);
  });
});
