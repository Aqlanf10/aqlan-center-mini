import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), recordPlanConsent: vi.fn(), schedulePlanInstallments: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", recordPlanConsent: boundary.recordPlanConsent,
  schedulePlanInstallments: boundary.schedulePlanInstallments }));
import { POST } from "../app/api/plans/[id]/consent/route";
const post = (body: unknown, id = "4") => POST(new Request(`http://localhost/api/plans/${id}/consent`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "consent-actor", role: "admin" });
  boundary.recordPlanConsent.mockResolvedValue({ ok: true, totalMinor: 3001, installments: 3 });
});
describe("atomic consent route", () => {
  it("sends one command with server identity and keeps the success body", async () => {
    const response = await post({ count: "3", everyDays: "30", firstDueDate: "2028-02-29", note: "Synthetic note", actor: "forged", actorRole: "doctor" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ totalMinor: 3001, installments: 3 });
    expect(boundary.recordPlanConsent).toHaveBeenCalledExactlyOnceWith({ planId: 4, actor: "consent-actor", actorRole: "admin", note: "Synthetic note",
      schedule: { count: 3, everyDays: 30, firstDueDate: "2028-02-29" } });
    expect(boundary.schedulePlanInstallments).not.toHaveBeenCalled();
  });
  it.each([{}, { count: 0 }])("consent only remains one command: %j", async (body) => {
    boundary.recordPlanConsent.mockResolvedValue({ ok: true, totalMinor: 3001, installments: 0 });
    const response = await post(body);
    expect(await response.json()).toEqual({ totalMinor: 3001, installments: 0 });
    expect(boundary.recordPlanConsent.mock.calls[0][0].schedule).toBeNull();
  });
  it.each([{ count: 61 }, { count: -1 }, { count: "bad" }, { count: null }, { count: 2, everyDays: 0 },
    { count: 2, everyDays: 366 }, { count: 2, firstDueDate: "2026-02-30" }, { count: 2, firstDueDate: "bad" }, [], "body"])(
    "rejects malformed input before any write: %j", async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(boundary.recordPlanConsent).not.toHaveBeenCalled();
      expect(boundary.schedulePlanInstallments).not.toHaveBeenCalled();
    });
  it.each(["admin", "reception", "cashier"])("preserves money role %s", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "consent-actor", role });
    expect((await post({})).status).toBe(201);
  });
  it.each([null, "doctor", "accountant", "assistant", "staff"])("denies missing session/disallowed role %s", async (role) => {
    boundary.requireSession.mockResolvedValue(role === null ? null : { username: "actor", role });
    expect((await post({})).status).toBe(role === null ? 401 : 403);
    expect(boundary.recordPlanConsent).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "x", "1.5"])("denies malformed plan id %s", async (id) => {
    expect((await post({}, id)).status).toBe(400); expect(boundary.recordPlanConsent).not.toHaveBeenCalled();
  });
  it("maps schedule conflict without a partial-success claim", async () => {
    boundary.recordPlanConsent.mockResolvedValue({ ok: false, message: "للخطة جدول أقساط سلفًا." });
    const response = await post({ count: 2 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "للخطة جدول أقساط سلفًا." });
  });
  it("maps thrown transactional audit/schedule failure to a generic error", async () => {
    boundary.recordPlanConsent.mockRejectedValue(new Error("synthetic audit failure"));
    const response = await post({ count: 2 });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تسجيل الموافقة." });
  });
});
