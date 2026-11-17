import { describe, expect, it } from "vitest";
import { decodePrescriptionPrintCursor, encodePrescriptionPrintCursor } from "../lib/prescription-print-pagination";
const cursor = { patientId: 7, visitId: null, id: 81, createdAt: "2026-10-30T10:11:12.123456Z" };
describe("prescription print keyset cursor", () => {
  it("roundtrips full PostgreSQL microseconds without truncation", () => {
    expect(decodePrescriptionPrintCursor(encodePrescriptionPrintCursor(cursor), 7, null)).toEqual(cursor);
    expect(decodePrescriptionPrintCursor(null, 7, null)).toBeNull();
  });
  it.each([{ ...cursor, patientId: 8 }, { ...cursor, visitId: 9 }, { ...cursor, id: 0 }, { ...cursor, id: 1.5 },
    { ...cursor, createdAt: "2026-02-30T10:11:12.123456Z" }, { ...cursor, createdAt: "2026-10-30T10:11:12.123Z" },
    { ...cursor, createdAt: "not a date" }])("rejects malformed or foreign scope %j", value => {
    expect(() => decodePrescriptionPrintCursor(encodePrescriptionPrintCursor(value), 7, null)).toThrow("CURSOR_INVALID");
  });
  it.each(["", "invalid", "x".repeat(401), "%20"])("rejects invalid encoding", raw => {
    expect(() => decodePrescriptionPrintCursor(raw, 7, null)).toThrow("CURSOR_INVALID");
  });
});
