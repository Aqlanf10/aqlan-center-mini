import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({ createCephAnalysis: vi.fn(), listPatientCephAnalyses: vi.fn() }));

import { POST } from "@/app/api/patients/[id]/ceph/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { createCephAnalysis, listPatientCephAnalyses } from "@/lib/db";

/**
 * (ORTHO-ID-2) «إضافة دراسة متابعة» دراسةٌ جديدة بمرحلتها وتاريخ أشعتها الفعليين: الخادم لا يصنّف طلبًا بلا مرحلة
 * «قبل العلاج» بصمت، ولا يحوّل تاريخًا خاطئًا إلى «غير معروف» بصمت.
 */
const ctx = { params: Promise.resolve({ id: "101" }) };
const post = (body: unknown) => POST(new Request("https://synthetic.invalid/api/patients/101/ceph", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), ctx);
const arabic = /[؀-ۿ]/;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ userId: 7, username: "synthetic-doctor", role: "doctor", expiresAt: 4_102_444_800_000 } as never);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(listPatientCephAnalyses).mockResolvedValue([]);
  vi.mocked(createCephAnalysis).mockResolvedValue({ ok: true, id: 55 });
});

describe("POST /api/patients/[id]/ceph — a follow-up study states its own stage and date", () => {
  it.each([undefined, null, "", "PRETREATMENT", "t1", 3, {}])("rejects a missing or unknown phase (%j) without creating a study", async (phase) => {
    const response = await post({ documentId: 9, phase });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(arabic);
    expect(createCephAnalysis).not.toHaveBeenCalled();
  });

  it.each(["pretreatment", "during", "posttreatment", "followup"])("passes the stated %s phase through unchanged", async (phase) => {
    const response = await post({ documentId: 9, phase, xrayDate: "2026-03-14", orthoCaseId: 4, refSet: "synthetic_local" });
    expect(response.status).toBe(201);
    expect(createCephAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 101, documentId: 9, phase, xrayDate: "2026-03-14", orthoCaseId: 4, refSet: "synthetic_local",
    }));
  });

  it.each(["2026-13-45", "14/03/2026", "2026-02-30", "yesterday"])("rejects a stated but malformed X-ray date %j instead of storing «unknown»", async (xrayDate) => {
    const response = await post({ documentId: 9, phase: "during", xrayDate });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(arabic);
    expect(createCephAnalysis).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ""])("keeps an absent X-ray date %j as unknown — never invented", async (xrayDate) => {
    const response = await post({ documentId: 9, phase: "during", xrayDate });
    expect(response.status).toBe(201);
    expect(createCephAnalysis).toHaveBeenCalledWith(expect.objectContaining({ xrayDate: null }));
  });
});
