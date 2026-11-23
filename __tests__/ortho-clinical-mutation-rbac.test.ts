import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrthoCase } from "@/lib/db";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getOrthoCase: vi.fn(), findUserByUsername: vi.fn(),
  recordAdjustment: vi.fn(), setOrthoPhase: vi.fn(), setRetainer: vi.fn(),
  closeOrthoCase: vi.fn(), linkOrthoCasePlan: vi.fn(),
}));

import { POST, PATCH } from "@/app/api/ortho/[id]/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import {
  getOrthoCase, recordAdjustment, setOrthoPhase, setRetainer,
  closeOrthoCase, linkOrthoCasePlan,
} from "@/lib/db";

const context = { params: Promise.resolve({ id: "41" }) };
const writers = [recordAdjustment, setOrthoPhase, setRetainer, closeOrthoCase, linkOrthoCasePlan];
const call = (method: "POST" | "PATCH", body: object) =>
  (method === "POST" ? POST : PATCH)(
    new Request("https://synthetic.invalid/api/ortho/41", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    context,
  );
const useRole = (role: "reception" | "assistant" | "cashier" | "accountant" | "doctor" | "admin") =>
  vi.mocked(requireSession).mockResolvedValue({
    userId: 7, username: "synthetic-" + role, role, expiresAt: 4_102_444_800_000,
  });
function noClinicalWrites() {
  for (const writer of [recordAdjustment, setOrthoPhase, setRetainer, closeOrthoCase]) {
    expect(writer).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  useRole("reception");
  vi.mocked(getOrthoCase).mockResolvedValue({
    id: 41, patientId: 101, status: "active",
  } as OrthoCase);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(recordAdjustment).mockResolvedValue({
    ok: true, id: 501, created: true, visitId: null, attachedToToday: false,
  });
  vi.mocked(linkOrthoCasePlan).mockResolvedValue({ ok: true, changed: true, funded: true });
});

describe("P0 orthodontic clinical mutation role boundary (synthetic-only)", () => {
  it.each(["reception", "assistant", "cashier", "accountant"] as const)(
    "denies %s tightening POST before reading a clinical case", async (role) => {
      useRole(role);
      const response = await call("POST", { phase: "aligning", done: "Synthetic note" });
      expect(response.status).toBe(403);
      expect(getOrthoCase).not.toHaveBeenCalled();
      expect(canAccessPatient).not.toHaveBeenCalled();
      for (const writer of writers) expect(writer).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: "working" },
    { retainer: "essix" },
    { status: "completed" },
  ])("prevents reception PATCH clinical action %j despite operational patient scope", async (body) => {
    const response = await call("PATCH", body);
    expect(response.status).toBe(403);
    // Deny before even resolving clinical case existence or patient scope.
    expect(getOrthoCase).not.toHaveBeenCalled();
    expect(canAccessPatient).not.toHaveBeenCalled();
    noClinicalWrites();
    expect(linkOrthoCasePlan).not.toHaveBeenCalled();
  });

  it("keeps receptionist's existing agreement-link workflow without clinical mutations", async () => {
    const response = await call("PATCH", { planId: null });
    expect(response.status).toBe(200);
    expect(linkOrthoCasePlan).toHaveBeenCalledWith({
      caseId: 41, planId: null, actor: "synthetic-reception", actorRole: "reception",
    });
    noClinicalWrites();
  });

  it.each(["doctor", "admin"] as const)("preserves patient-scoped %s tightening", async (role) => {
    useRole(role);
    const response = await call("POST", { phase: "aligning", nextWeeks: 4 });
    expect(response.status).toBe(201);
    expect(canAccessPatient).toHaveBeenCalled();
    expect(recordAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 41, actorRole: role }),
    );
  });

  it("rejects primitive PATCH JSON for front desk without throwing or invoking a writer", async () => {
    const response = await PATCH(
      new Request("https://synthetic.invalid/api/ortho/41", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify("synthetic unexpected payload"),
      }),
      context,
    );
    expect(response.status).toBe(403);
    for (const writer of writers) expect(writer).not.toHaveBeenCalled();
  });

  it("rejects malformed clinician PATCH bodies with 400 and no case query or write", async () => {
    useRole("doctor");
    for (const body of [null, [], "unexpected", 42]) {
      vi.mocked(getOrthoCase).mockClear();
      const response = await PATCH(
        new Request("https://synthetic.invalid/api/ortho/41", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        context,
      );
      expect(response.status).toBe(400);
      expect(getOrthoCase).not.toHaveBeenCalled();
      for (const writer of writers) expect(writer).not.toHaveBeenCalled();
    }
  });

  it("keeps the patient-ownership gate for an authorized doctor", async () => {
    useRole("doctor");
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect((await call("POST", { phase: "aligning" })).status).toBe(403);
    for (const writer of writers) expect(writer).not.toHaveBeenCalled();
  });
});
