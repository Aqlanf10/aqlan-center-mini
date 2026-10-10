import { describe, expect, it } from "vitest";
import { canReadReceptionHandoff, isHandoffDate, readReceptionHandoffs, receptionCheckoutHref } from "../lib/reception-handoff";

const owner = { username: "synthetic-reception", role: "reception" };
const row = { visitId: 17, patientId: 31, patientName: "مريض اصطناعي", patientNumber: "SYN-31", signedAt: "2026-10-09T21:00:00.000Z" };
const payload = () => ({ owner, fromDate: "2026-10-09", toDate: "2026-10-10", clinicTimeZone: "Asia/Aden", items: [row] });

describe("committed-signature handoff contract", () => {
  it("limits the register to existing front-desk checkout roles", () => {
    for (const role of ["admin", "reception"]) expect(canReadReceptionHandoff(role)).toBe(true);
    for (const role of ["assistant", "doctor", "cashier", "accountant", null, undefined]) expect(canReadReceptionHandoff(role)).toBe(false);
  });
  it("accepts complete owner-bound data and retains the exact patient and visit link", () => {
    expect(readReceptionHandoffs(payload(), owner, null)?.items).toEqual([row]);
    expect(receptionCheckoutHref(row)).toBe("/patients/31?tab=today&checkoutVisit=17");
    expect(readReceptionHandoffs({ ...payload(), items: [] }, owner, null)?.items).toEqual([]);
  });
  it("validates actual calendar dates without numeric coercion", () => {
    expect(isHandoffDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "", null, 20261010]) expect(isHandoffDate(bad)).toBe(false);
  });
  it("rejects missing, malformed, duplicate, and unsafe identities rather than displaying an empty success", () => {
    for (const bad of [null, {}, { ...payload(), items: null }, { ...payload(), items: [row, row] },
      { ...payload(), items: [{ ...row, visitId: "17" }] }, { ...payload(), items: [{ ...row, patientId: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...payload(), items: [{ ...row, signedAt: null }] }, { ...payload(), items: [{ ...row, patientName: "" }] }]) {
      expect(readReceptionHandoffs(bad, owner, null)).toBeNull();
    }
  });
  it("rejects owner, date-window and timezone mismatches", () => {
    expect(readReceptionHandoffs(payload(), { ...owner, username: "other" }, null)).toBeNull();
    expect(readReceptionHandoffs(payload(), { ...owner, role: "doctor" }, null)).toBeNull();
    expect(readReceptionHandoffs(payload(), owner, "2026-10-09")).toBeNull();
    expect(readReceptionHandoffs({ ...payload(), fromDate: "2026-10-01" }, owner, null)).toBeNull();
    expect(readReceptionHandoffs({ ...payload(), clinicTimeZone: "invalid" }, owner, null)).toBeNull();
  });
  it("uses clinic-local midnight, not arrival time or the client's UTC calendar", () => {
    expect(readReceptionHandoffs({ ...payload(), fromDate: "2026-10-08", toDate: "2026-10-09" }, owner, null)).toBeNull();
    expect(readReceptionHandoffs({ ...payload(), items: [{ ...row, signedAt: "2026-10-08T21:00:00Z" }] }, owner, null)?.items).toHaveLength(1);
    expect(readReceptionHandoffs({ ...payload(), items: [{ ...row, signedAt: "2026-10-08T20:59:59Z" }] }, owner, null)).toBeNull();
  });
});
