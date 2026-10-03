import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), recordPlanInstallmentReminder: vi.fn(), recordAudit: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ recordPlanInstallmentReminder: boundary.recordPlanInstallmentReminder, recordAudit: boundary.recordAudit }));
import { POST } from "../app/api/plans/reminders/route";
const actor = { userId: 7, username: "reminder-doctor", role: "doctor", credentialVersion: "current-version" };
const timestamp = "2026-10-03T10:00:00.000Z";
const post = (body: unknown) => POST(new Request("http://localhost/api/plans/reminders", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ ...actor, partyId: 99 });
  boundary.recordPlanInstallmentReminder.mockResolvedValue({ ok: true, updatedCount: 2, lastReminderAt: timestamp });
});
describe("single actor-bound reminder command at the real route", () => {
  it("passes server identity only and preserves single response", async () => {
    const response = await post({ planId: 4, installmentNumber: 2, actor: { role: "admin", userId: 1 }, role: "admin", partyId: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, planId: 4, installmentNumber: 2, lastReminderAt: timestamp });
    expect(boundary.recordPlanInstallmentReminder).toHaveBeenCalledExactlyOnceWith({ actor,
      target: { kind: "single", planId: 4, installmentNumber: 2 } });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("deduplicates one bulk command and reports unique committed count", async () => {
    const response = await post({ planIds: [8, 2, 8] });
    expect(await response.json()).toEqual({ success: true, updatedCount: 2, lastReminderAt: timestamp });
    expect(boundary.recordPlanInstallmentReminder).toHaveBeenCalledExactlyOnceWith({ actor, target: { kind: "bulk", planIds: [2, 8] } });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "doctor"])("keeps effective role %s", async (role) => {
    boundary.requireSession.mockResolvedValue({ ...actor, role });
    expect((await post({ planId: 4 })).status).toBe(200);
  });
  it.each([null, "cashier", "accountant", "assistant", "staff"])("rejects missing session/disallowed role %s", async (role) => {
    boundary.requireSession.mockResolvedValue(role === null ? null : { ...actor, role });
    expect((await post({ planId: 4 })).status).toBe(role === null ? 401 : 403);
    expect(boundary.recordPlanInstallmentReminder).not.toHaveBeenCalled();
  });
  it.each([{ planIds: [1, "bad"] }, { planId: 1, planIds: [1] }, { planId: 1, installmentNumber: -1 },
    { planId: 1, installmentNumber: "bad" }, { planIds: [1], installmentNumber: 2 }, null, []])("rejects malformed scope before command: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(boundary.recordPlanInstallmentReminder).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409])("maps transaction refusal %s without detached audit", async (status) => {
    boundary.recordPlanInstallmentReminder.mockResolvedValue({ ok: false, status, message: "تعذّر الحفظ" });
    expect((await post({ planId: 4 })).status).toBe(status);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("reports database/audit errors as Arabic 500 without a false timestamp", async () => {
    boundary.recordPlanInstallmentReminder.mockRejectedValue(new Error("synthetic audit failure"));
    const response = await post({ planIds: [2, 4] });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تسجيل تاريخ التذكير." });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
});
