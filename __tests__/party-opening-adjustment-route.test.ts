import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), adjustPartyOpeningPayable: vi.fn(), voidPartyOpeningAdvance: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", ...boundary,
  createPartyOpeningAdvance: vi.fn(), createPartyOpeningPayable: vi.fn(),
  getSettings: vi.fn(), isPeriodLocked: vi.fn(), listParties: vi.fn(), listPartyOpenings: vi.fn(),
}));

import { PATCH } from "@/app/api/party-openings/route";

const request = (body: Record<string, unknown> = {}) => PATCH(new Request("https://synthetic.invalid/api/party-openings", {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "adjust", payableId: 41, amount: "100.25", reason: "Synthetic correction", ...body }),
}));
const noWrites = () => {
  expect(boundary.adjustPartyOpeningPayable).not.toHaveBeenCalled();
  expect(boundary.voidPartyOpeningAdvance).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  boundary.adjustPartyOpeningPayable.mockResolvedValue({ ok: true, value: { id: 41, currency: "SAR", amountMinor: 10025 } });
  boundary.voidPartyOpeningAdvance.mockResolvedValue({ ok: true, value: { id: 12, voidedBy: "synthetic-admin" } });
});

describe("party opening PATCH delegates currency authority to the transaction", () => {
  it.each([undefined, "YER", "SAR", "USD"])("forwards raw amount with optional expected currency %s", async currency => {
    const response = await request({ currency });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 41, currency: "SAR", amountMinor: 10025 });
    expect(boundary.adjustPartyOpeningPayable).toHaveBeenCalledExactlyOnceWith({
      payableId: 41, amount: "100.25", expectedCurrency: currency,
      reason: "Synthetic correction", actor: "synthetic-admin", actorRole: "admin",
    });
  });

  it("retains numeric JSON amount support without scaling in the route", async () => {
    expect((await request({ amount: 100.25, currency: "USD" })).status).toBe(200);
    expect(boundary.adjustPartyOpeningPayable).toHaveBeenCalledWith(expect.objectContaining({ amount: "100.25", expectedCurrency: "USD" }));
  });

  it.each([null, "", "EUR", true, 1])("refuses explicitly invalid currency %s before mutation", async currency => {
    expect((await request({ currency })).status).toBe(400); noWrites();
  });

  it.each([400, 404, 409])("preserves domain refusal %s instead of claiming success", async status => {
    boundary.adjustPartyOpeningPayable.mockResolvedValue({ ok: false, status, message: "Synthetic refusal" });
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message: "Synthetic refusal" });
  });

  it("keeps unrelated failures generic", async () => {
    boundary.adjustPartyOpeningPayable.mockRejectedValue(new Error("Synthetic private database detail"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر حفظ التصحيح." });
  });

  it("refuses expired sessions before mutation", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await request()).status).toBe(401); noWrites();
  });

  it.each(["cashier", "accountant", "reception", "doctor"])("keeps %s forbidden before mutation", async role => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-user", role });
    expect((await request()).status).toBe(403); noWrites();
  });

  it.each(["", "ab", "  "])("preserves reason requirement for %s", async reason => {
    expect((await request({ reason })).status).toBe(400); noWrites();
  });

  it.each([0, -1, 1.5, "invalid"])("rejects invalid payable id %s", async payableId => {
    expect((await request({ payableId })).status).toBe(400); noWrites();
  });

  it("preserves malformed JSON rejection", async () => {
    const response = await PATCH(new Request("https://synthetic.invalid/api/party-openings", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{",
    }));
    expect(response.status).toBe(400); noWrites();
  });

  it("keeps advance voiding separate from payable amount and currency validation", async () => {
    const response = await request({ action: "void_advance", id: 12 });
    expect(response.status).toBe(200);
    expect(boundary.voidPartyOpeningAdvance).toHaveBeenCalledExactlyOnceWith({
      id: 12, reason: "Synthetic correction", actor: "synthetic-admin", actorRole: "admin",
    });
    expect(boundary.adjustPartyOpeningPayable).not.toHaveBeenCalled();
  });
});
