import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrthoCase } from "@/lib/db";
import { RETAINER_LABEL } from "@/lib/ortho";

// Intent-wiring test only. Persistence and lock-current decisions belong to
// postgres/ortho-retainer-date.test.ts, which imports the real writer.
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getOrthoCase: vi.fn(), findUserByUsername: vi.fn(),
  setOrthoPhase: vi.fn(), setRetainer: vi.fn(), recordAdjustment: vi.fn(),
  closeOrthoCase: vi.fn(), linkOrthoCasePlan: vi.fn(),
}));

import { PATCH } from "@/app/api/ortho/[id]/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { getOrthoCase, setRetainer, setOrthoPhase, recordAdjustment, closeOrthoCase, linkOrthoCasePlan } from "@/lib/db";

const FOUND = {
  id: 41, patientId: 101, status: "retention", phase: "finishing",
  retainer: "essix", retainerOn: "2026-08-20",
} as OrthoCase;

async function patch(body: unknown) {
  return PATCH(new Request("https://synthetic.invalid/api/ortho/41", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "41" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  // In Asia/Aden this is already October 6, but UTC is still October 5.
  vi.setSystemTime(new Date("2026-10-05T21:30:00.000Z"));
  vi.mocked(requireSession).mockResolvedValue({
    userId: 7, username: "synthetic-admin", role: "admin", expiresAt: 4_102_444_800_000,
  });
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getOrthoCase).mockResolvedValue(FOUND);
  vi.mocked(setRetainer).mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); });

describe("PATCH retainer delivery-date intent", () => {
  it.each([
    ["2026-10-05T20:59:59.000Z", "2026-10-05"],
    ["2026-10-05T21:00:00.000Z", "2026-10-06"],
  ])("type-only save at %s passes clinic fallback %s and preservation intent", async (instant, today) => {
    vi.setSystemTime(new Date(instant));
    const response = await patch({ retainer: "essix" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(getOrthoCase).toHaveBeenCalledExactlyOnceWith(41, today);
    // Never pass FOUND.retainerOn as the date: that unlocked snapshot may be stale.
    expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
      id: 41, retainer: "essix", deliveredOn: today, preserveExistingDeliveryDate: true,
    });
    for (const writer of [setOrthoPhase, recordAdjustment, closeOrthoCase, linkOrthoCasePlan]) {
      expect(writer).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, null, "", "2026/10/01", " 2026-10-01 ", 20261001, false, {}])(
    "keeps the existing fallback classification of retainerOn=%j", async (retainerOn) => {
      expect((await patch({ retainer: "essix", retainerOn })).status).toBe(200);
      expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
        id: 41, retainer: "essix", deliveredOn: "2026-10-06", preserveExistingDeliveryDate: true,
      });
    },
  );

  it.each(["2026-07-15", "2026-10-06", "2026-11-02", "2026-02-30"])(
    "explicit shape-valid date %s remains an exact writer request", async (retainerOn) => {
      // Calendar validation is deliberately unchanged; PostgreSQL rejects the
      // impossible date. This mocked route test does not claim it can be stored.
      expect((await patch({ retainer: "essix", retainerOn })).status).toBe(200);
      expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
        id: 41, retainer: "essix", deliveredOn: retainerOn, preserveExistingDeliveryDate: false,
      });
    },
  );

  it.each(Object.keys(RETAINER_LABEL).filter((retainer) => retainer !== "none"))(
    "all delivery types, including a changed type %s, delegate the lock-current choice", async (retainer) => {
      expect((await patch({ retainer })).status).toBe(200);
      expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
        id: 41, retainer, deliveredOn: "2026-10-06", preserveExistingDeliveryDate: true,
      });
    },
  );

  it.each([
    { retainerOn: undefined, preserve: true },
    { retainerOn: null, preserve: true },
    { retainerOn: "2026-07-15", preserve: false },
    { retainerOn: "2026-02-30", preserve: false },
  ])("none always clears delivery date: $retainerOn", async ({ retainerOn, preserve }) => {
    expect((await patch({ retainer: "none", retainerOn })).status).toBe(200);
    expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
      id: 41, retainer: "none", deliveredOn: null, preserveExistingDeliveryDate: preserve,
    });
  });

  it("does not decide preservation from the earlier case snapshot", async () => {
    vi.mocked(getOrthoCase).mockResolvedValue({ ...FOUND, retainer: "hawley", retainerOn: null });
    expect((await patch({ retainer: "essix" })).status).toBe(200);
    expect(setRetainer).toHaveBeenCalledExactlyOnceWith({
      id: 41, retainer: "essix", deliveredOn: "2026-10-06", preserveExistingDeliveryDate: true,
    });
  });

  it("retains conflict and error responses from the real writer contract", async () => {
    vi.mocked(setRetainer).mockResolvedValueOnce(false);
    const conflict = await patch({ retainer: "essix" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ message: "الحالة مغلقة أو غير موجودة." });
    vi.mocked(setRetainer).mockRejectedValueOnce(new Error("Synthetic failure"));
    expect((await patch({ retainer: "essix" })).status).toBe(500);
  });
});
