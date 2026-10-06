import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningBalance } from "@/lib/db";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  OpeningBalanceExists: class extends Error {},
  OpeningBalanceChanged: class extends Error { constructor() { super("تغيّر الرصيد الافتتاحي. أعد تحميله وراجع التعديل."); } },
  getSettings: vi.fn(), isPeriodLocked: vi.fn(), getPatientOpeningBalance: vi.fn(),
  setPatientOpeningBalance: vi.fn(), clearPatientOpeningBalance: vi.fn(), recordAudit: vi.fn(),
  listOpeningBalanceHistory: vi.fn(), listOpeningBalances: vi.fn(),
}));

import { POST, DELETE } from "@/app/api/opening-balances/route";
import { requireSession } from "@/lib/session";
import {
  OpeningBalanceChanged, OpeningBalanceExists, getSettings, isPeriodLocked, getPatientOpeningBalance,
  setPatientOpeningBalance, clearPatientOpeningBalance, recordAudit,
} from "@/lib/db";

const existing: OpeningBalance = {
  patientId: 41, patientName: "Synthetic opening patient", phone: null, currency: "SAR",
  amountMinor: 35000, asOfDate: "2026-01-01", note: null, createdBy: "synthetic-admin", updatedAt: "2026-01-01T00:00:00.000Z",
};
const expectedBefore = { amountMinor: 35000, asOfDate: "2026-01-01" };
const post = (body: Record<string, unknown> = {}) => POST(new Request("https://synthetic.invalid/api/opening-balances", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ patientId: 41, currency: "SAR", amount: "300", asOfDate: "2026-01-01", reason: "Synthetic correction", ...body }),
}));
const clear = () => DELETE(new Request("https://synthetic.invalid/api/opening-balances?patientId=41&currency=SAR&reason=Synthetic%20correction", { method: "DELETE" }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ userId: 1, username: "synthetic-admin", role: "admin", expiresAt: 4_102_444_800_000 });
  vi.mocked(getSettings).mockResolvedValue({ "finance.reception_adds_opening_balance": "true" } as Awaited<ReturnType<typeof getSettings>>);
  vi.mocked(isPeriodLocked).mockResolvedValue(false);
  vi.mocked(getPatientOpeningBalance).mockResolvedValue(existing);
  vi.mocked(setPatientOpeningBalance).mockResolvedValue({ ...existing, amountMinor: 30000 });
  vi.mocked(clearPatientOpeningBalance).mockResolvedValue(true);
});

function noWrites() {
  expect(setPatientOpeningBalance).not.toHaveBeenCalled();
  expect(clearPatientOpeningBalance).not.toHaveBeenCalled();
  expect(recordAudit).not.toHaveBeenCalled();
}

describe("opening mutation preflight ownership", () => {
  it("binds an existing correction and its audit to the checked original financial values", async () => {
    expect((await post()).status).toBe(201);
    expect(setPatientOpeningBalance).toHaveBeenCalledWith(expect.objectContaining({ expectedBefore, reason: "Synthetic correction", addOnly: false }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ المبلغ_السابق: 35000, التاريخ_السابق: "2026-01-01" }) }));
  });

  it.each(["admin", "reception"] as const)("binds %s creation to the checked absence, even if a reason was supplied", async (role) => {
    vi.mocked(requireSession).mockResolvedValue({ userId: 1, username: "synthetic-user", role, expiresAt: 4_102_444_800_000 });
    vi.mocked(getPatientOpeningBalance).mockResolvedValue(null);
    expect((await post()).status).toBe(201);
    expect(setPatientOpeningBalance).toHaveBeenCalledWith(expect.objectContaining({ expectedBefore: null, addOnly: role === "reception" }));
  });

  it("ignores a client-supplied preflight snapshot", async () => {
    expect((await post({ expectedBefore: null })).status).toBe(201);
    expect(setPatientOpeningBalance).toHaveBeenCalledWith(expect.objectContaining({ expectedBefore }));
  });

  it("returns a retryable conflict without a success audit if a correction target changed", async () => {
    vi.mocked(setPatientOpeningBalance).mockRejectedValue(new OpeningBalanceChanged());
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "تغيّر الرصيد الافتتاحي. أعد تحميله وراجع التعديل." });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("keeps reception's concurrent duplicate refusal forbidden", async () => {
    vi.mocked(getPatientOpeningBalance).mockResolvedValue(null);
    vi.mocked(setPatientOpeningBalance).mockRejectedValue(new OpeningBalanceExists());
    expect((await post()).status).toBe(403);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("binds clear to the checked original financial values", async () => {
    expect((await clear()).status).toBe(200);
    expect(clearPatientOpeningBalance).toHaveBeenCalledWith(41, "synthetic-admin", "Synthetic correction", "SAR", expectedBefore);
    expect(recordAudit).toHaveBeenCalledOnce();
  });

  it("does not clear or audit success for a changed original", async () => {
    vi.mocked(clearPatientOpeningBalance).mockRejectedValue(new OpeningBalanceChanged());
    const response = await clear();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "تغيّر الرصيد الافتتاحي. أعد تحميله وراجع التعديل." });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("does not claim clear success if its transaction found no balance", async () => {
    vi.mocked(clearPatientOpeningBalance).mockResolvedValue(false);
    expect((await clear()).status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it.each(["post", "clear"] as const)("preserves original-period refusal before %s", async (action) => {
    vi.mocked(isPeriodLocked).mockImplementation(async (date) => date === existing.asOfDate);
    const response = action === "post" ? await post({ asOfDate: "2026-02-01" }) : await clear();
    expect(response.status).toBe(409); noWrites();
  });

  it("preserves reason requirement", async () => {
    expect((await post({ reason: " " })).status).toBe(400); noWrites();
  });

  it("preserves reception edit denial", async () => {
    vi.mocked(requireSession).mockResolvedValue({ userId: 1, username: "synthetic-user", role: "reception", expiresAt: 4_102_444_800_000 });
    expect((await post()).status).toBe(403); noWrites();
  });

  it.each(["post", "clear"] as const)("keeps an unrelated %s writer error distinct from a conflict", async (action) => {
    vi.mocked(setPatientOpeningBalance).mockRejectedValue(new Error("Synthetic unavailable"));
    vi.mocked(clearPatientOpeningBalance).mockRejectedValue(new Error("Synthetic unavailable"));
    expect((await (action === "post" ? post() : clear())).status).toBe(500);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
