import { describe, expect, it } from "vitest";
import { isClinicalSignResult } from "../lib/clinical-sign-result";

const result = { patientId: 19, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null };
describe("confirmed clinical sign DTO", () => {
  it("accepts the no-invoice result and a current owned invoice/next-visit result", () => {
    expect(isClinicalSignResult(result, 61, 19)).toBe(true);
    expect(isClinicalSignResult({ ...result, id: 61, status: "signed", invoiceId: 81, invoiceCurrency: "USD", duesMinor: 425,
      nextPlannedVisit: { id: 91, title: "Synthetic next visit", sequence: 1, durationMinutes: 30, suggestedDate: null, afterDays: 7 } }, 61, 19)).toBe(true);
  });
  it.each([null, [], {}, { ...result, patientId: 20 }, { ...result, id: 62 }, { ...result, status: "open" },
    { ...result, invoiceId: 81 }, { ...result, invoiceCurrency: "BAD" }, { ...result, duesMinor: -1 },
    { ...result, sessionsCompleted: 0.5 }, { ...result, nextPlannedVisit: {} }, { ...result, materialsDeducted: "1" }])(
    "rejects malformed or foreign-owner result %j", (payload) => expect(isClinicalSignResult(payload, 61, 19)).toBe(false),
  );
});
