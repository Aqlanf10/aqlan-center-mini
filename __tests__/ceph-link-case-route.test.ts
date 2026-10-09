import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCephStudy: vi.fn(), linkCephStudyToCase: vi.fn() }));

import { POST } from "@/app/api/ceph/[id]/link-case/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { getCephStudy, linkCephStudyToCase } from "@/lib/db";

const arabic = /[؀-ۿ]/;
const good = { orthoCaseId: 4, confirm: true, expected: { phase: "pretreatment", xrayDate: "2025-11-20", status: "completed" } };
const call = (body: unknown, id = "41") => POST(new Request(`https://synthetic.invalid/api/ceph/${id}/link-case`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) });
const as = (role: string | null) => vi.mocked(requireSession).mockResolvedValue(role === null ? null as never : {
  userId: 7, username: `synthetic-${role}`, role, expiresAt: 4_102_444_800_000,
} as never);

beforeEach(() => {
  vi.resetAllMocks();
  as("doctor");
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getCephStudy).mockResolvedValue({ analysis: { id: 41, patientId: 101 } } as never);
  vi.mocked(linkCephStudyToCase).mockResolvedValue({ ok: true, changed: true });
});

describe("POST /api/ceph/[id]/link-case — explicit, confirmed, clinician-only", () => {
  it("links for a doctor and for an admin, passing the stated context and the real actor", async () => {
    for (const role of ["doctor", "admin"]) {
      as(role);
      const response = await call(good);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, changed: true });
      expect(linkCephStudyToCase).toHaveBeenLastCalledWith({
        analysisId: 41, orthoCaseId: 4, expected: good.expected, actor: `synthetic-${role}`, actorRole: role,
      });
    }
  });

  it.each(["reception", "assistant", "cashier", "accountant"])("403 for %s before touching anything", async (role) => {
    as(role);
    const response = await call(good);
    expect(response.status).toBe(403);
    expect((await response.json()).message).toMatch(arabic);
    expect(getCephStudy).not.toHaveBeenCalled();
    expect(linkCephStudyToCase).not.toHaveBeenCalled();
  });

  it("401 without a session", async () => {
    as(null);
    expect((await call(good)).status).toBe(401);
    expect(linkCephStudyToCase).not.toHaveBeenCalled();
  });

  it.each([
    ["no confirmation", { ...good, confirm: false }],
    ["confirmation as text", { ...good, confirm: "true" }],
    ["no case", { ...good, orthoCaseId: undefined }],
    ["case zero", { ...good, orthoCaseId: 0 }],
    ["case as text", { ...good, orthoCaseId: "4" }],
    ["no context", { orthoCaseId: 4, confirm: true }],
    ["unknown phase", { ...good, expected: { ...good.expected, phase: "T1" } }],
    ["unknown status", { ...good, expected: { ...good.expected, status: "discarded" } }],
    ["malformed date", { ...good, expected: { ...good.expected, xrayDate: "2025-13-40" } }],
  ])("400 for %s — nothing is written", async (_name, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(arabic);
    expect(linkCephStudyToCase).not.toHaveBeenCalled();
  });

  it("an unknown date in the stated context is accepted as null", async () => {
    const response = await call({ ...good, expected: { ...good.expected, xrayDate: null } });
    expect(response.status).toBe(200);
    expect(linkCephStudyToCase).toHaveBeenCalledWith(expect.objectContaining({ expected: { ...good.expected, xrayDate: null } }));
  });

  it("400 for a bad study id; 404 when the study is missing; 403 outside the actor's patient scope", async () => {
    expect((await call(good, "abc")).status).toBe(400);
    vi.mocked(getCephStudy).mockResolvedValueOnce(null);
    expect((await call(good)).status).toBe(404);
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect((await call(good)).status).toBe(403);
    expect(linkCephStudyToCase).not.toHaveBeenCalled();
  });

  it("passes the domain refusal status and Arabic message through (404 / 409)", async () => {
    for (const status of [404, 409] as const) {
      vi.mocked(linkCephStudyToCase).mockResolvedValueOnce({ ok: false, status, message: "رسالة عربية من الخادم" });
      const response = await call(good);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: "رسالة عربية من الخادم" });
    }
  });

  it("an unexpected failure is a generic Arabic 500 with no exception text", async () => {
    vi.mocked(linkCephStudyToCase).mockRejectedValueOnce(new Error("synthetic audit failure"));
    const response = await call(good);
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.message).toMatch(arabic);
    expect(JSON.stringify(payload)).not.toContain("synthetic audit failure");
  });
});
