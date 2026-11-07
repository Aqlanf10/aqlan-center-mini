import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
const user = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ findUserByUsername: user }));
import { canPrintSavedPrescription } from "../lib/prescription-print-access";
const session = { userId: 3, username: "synthetic", role: "reception" } as SessionPayload;
beforeEach(() => { user.mockReset(); });
describe("fresh saved prescription print permission", () => {
  it.each(["admin", "doctor"] as const)("preserves %s access", async role => {
    expect(await canPrintSavedPrescription({ ...session, role })).toBe(true);
    expect(user).not.toHaveBeenCalled();
  });
  it.each(["assistant", "cashier", "accountant"] as const)("rejects %s", async role => {
    expect(await canPrintSavedPrescription({ ...session, role })).toBe(false);
  });
  it("requires an explicit boolean reception grant", () => {
    for (const value of [undefined, false, "true", 1]) {
      expect(parseDoctorPermissions({ canPrintSavedPrescriptions: value }, "reception").canPrintSavedPrescriptions).toBe(false);
    }
    expect(parseDoctorPermissions({ canPrintSavedPrescriptions: true }, "reception").canPrintSavedPrescriptions).toBe(true);
  });
  it.each([
    null,
    { id: 3, role: "reception", isActive: false, permissions: { canPrintSavedPrescriptions: true } },
    { id: 4, role: "reception", isActive: true, permissions: { canPrintSavedPrescriptions: true } },
    { id: 3, role: "doctor", isActive: true, permissions: { canPrintSavedPrescriptions: true } },
    { id: 3, role: "reception", isActive: true, permissions: { canPrintSavedPrescriptions: "true" } },
  ])("fails closed for invalid fresh account %j", async record => {
    user.mockResolvedValue(record);
    expect(await canPrintSavedPrescription(session)).toBe(false);
  });
  it("honors a fresh grant and fails closed after revocation or lookup failure", async () => {
    user.mockResolvedValue({ id: 3, role: "reception", isActive: true, permissions: { canPrintSavedPrescriptions: true } });
    expect(await canPrintSavedPrescription(session)).toBe(true);
    user.mockRejectedValue(new Error("offline"));
    expect(await canPrintSavedPrescription(session)).toBe(false);
    expect(user).toHaveBeenCalledWith(session.username);
  });
});
