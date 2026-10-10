import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", recordOrthoBaseline: vi.fn() }));

import { POST } from "@/app/api/ortho/baseline/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { recordOrthoBaseline } from "@/lib/db";

const body = {
  patientId: 101, phase: "working", financialMode: "opening_balance", monthsElapsed: 10, monthsRemaining: 8,
};
const request = (payload: unknown = body) => new Request("https://synthetic.invalid/api/ortho/baseline", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});
const as = (role: string) => vi.mocked(requireSession).mockResolvedValue({
  userId: 7, username: `synthetic-${role}`, role, expiresAt: 4_102_444_800_000,
} as never);

beforeEach(() => {
  vi.resetAllMocks();
  as("doctor");
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(recordOrthoBaseline).mockResolvedValue({ ok: true, id: 55 });
});

describe("POST /api/ortho/baseline — bridge refusal and admission", () => {
  it("answers 409 with an Arabic message and no internals when the bridge refuses", async () => {
    vi.mocked(recordOrthoBaseline).mockResolvedValue({ ok: false, reason: "bridge_conflict" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.message).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(payload)).not.toMatch(/bridge_conflict|stack|Error/);
  });

  it("201 for a doctor and for an admin", async () => {
    for (const role of ["doctor", "admin"]) {
      as(role);
      const response = await POST(request());
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 55 });
    }
  });

  it.each(["reception", "assistant", "cashier", "accountant"])("403 for %s without reaching the writer", async (role) => {
    as(role);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    expect(recordOrthoBaseline).not.toHaveBeenCalled();
  });

  it("401 without a session and 403 when the patient is out of the actor's scope — nothing written", async () => {
    vi.mocked(requireSession).mockResolvedValue(null as never);
    expect((await POST(request())).status).toBe(401);
    as("doctor");
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(recordOrthoBaseline).not.toHaveBeenCalled();
  });

  it("an unexpected writer failure is a generic Arabic 500 without the exception text", async () => {
    vi.mocked(recordOrthoBaseline).mockRejectedValue(new Error("synthetic audit failure"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.message).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(payload)).not.toContain("synthetic audit failure");
  });
});
