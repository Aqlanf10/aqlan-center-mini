import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn(), revalidateSessionInTransaction: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getCephStudy: vi.fn(), completeCephAnalysis: vi.fn(), discardCephAnalysis: vi.fn(),
  createCephAnalysis: vi.fn(), duplicateCephAnalysis: vi.fn(), listPatientCephAnalyses: vi.fn(),
}));

import { POST as complete } from "@/app/api/ceph/[id]/complete/route";
import { DELETE as discard } from "@/app/api/ceph/[id]/route";
import { POST as create } from "@/app/api/patients/[id]/ceph/route";
import { POST as duplicate } from "@/app/api/ceph/[id]/duplicate/route";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import {
  completeCephAnalysis, createCephAnalysis, discardCephAnalysis, duplicateCephAnalysis, getCephStudy, listPatientCephAnalyses,
} from "@/lib/db";

const arabic = /[؀-ۿ]/;
const ctx = { params: Promise.resolve({ id: "41" }) };
const req = (body: unknown = {}) => new Request("https://synthetic.invalid/x", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const session = { userId: 7, username: "synthetic-doctor", role: "doctor", expiresAt: 4_102_444_800_000 };
const createBody = { documentId: 5, phase: "pretreatment", xrayDate: "2025-11-20" };

const routes = {
  complete: { run: () => complete(req(), ctx), fn: () => vi.mocked(completeCephAnalysis), optionsAt: 2 },
  discard: { run: () => discard(req({ note: "x" }), ctx), fn: () => vi.mocked(discardCephAnalysis), optionsAt: 3 },
  duplicate: { run: () => duplicate(req(), ctx), fn: () => vi.mocked(duplicateCephAnalysis), optionsAt: 2 },
  create: { run: () => create(req(createBody), ctx), fn: () => vi.mocked(createCephAnalysis), optionsAt: 0 },
} as const;
type Name = keyof typeof routes;
const names = Object.keys(routes) as Name[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue(session as never);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getCephStudy).mockResolvedValue({ analysis: { id: 41, patientId: 101 } } as never);
  vi.mocked(listPatientCephAnalyses).mockResolvedValue([] as never);
  vi.mocked(completeCephAnalysis).mockResolvedValue({ ok: true, measurements: 1, summary: null } as never);
  vi.mocked(discardCephAnalysis).mockResolvedValue({ ok: true });
  vi.mocked(duplicateCephAnalysis).mockResolvedValue({ ok: true, id: 9, replayed: false });
  vi.mocked(createCephAnalysis).mockResolvedValue({ ok: true, id: 9 });
});

const optionsOf = (name: Name) => {
  const call = routes[name].fn().mock.calls[0] as unknown[];
  const { optionsAt } = routes[name];
  return (optionsAt === 0 ? call[0] : call[optionsAt]) as { authorize?: (c: never, patientId: number) => Promise<boolean> };
};

describe("Ceph write routes — in-transaction authority is wired and refusals keep their status", () => {
  it.each(names)("%s passes a transaction authorizer that re-validates the approved session", async (name) => {
    await routes[name].run();
    const { authorize } = optionsOf(name);
    expect(authorize).toEqual(expect.any(Function));
    const client = { query: vi.fn() } as never;
    vi.mocked(revalidateSessionInTransaction).mockResolvedValue(session as never);
    expect(await authorize!(client, 101)).toBe(true);
    expect(revalidateSessionInTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ username: "synthetic-doctor" }), client);
    expect(canAccessPatient).toHaveBeenLastCalledWith(session, 101, "canUploadXrays", client);
    // credentials / role / account changed while waiting → refused without consulting patient scope
    vi.mocked(revalidateSessionInTransaction).mockResolvedValue(null);
    vi.mocked(canAccessPatient).mockClear();
    expect(await authorize!(client, 101)).toBe(false);
    expect(canAccessPatient).not.toHaveBeenCalled();
    // study moved to a patient the actor has no authority on
    vi.mocked(revalidateSessionInTransaction).mockResolvedValue(session as never);
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect(await authorize!(client, 202)).toBe(false);
  });

  it.each(names)("%s passes the domain refusal status (403 / 404) and Arabic message through; default stays 409", async (name) => {
    for (const status of [403, 404, undefined]) {
      routes[name].fn().mockResolvedValueOnce({ ok: false, status, message: "رسالة عربية من الخادم" } as never);
      const response = await routes[name].run();
      expect(response.status).toBe(status ?? 409);
      const payload = await response.json();
      expect(payload.message).toMatch(arabic);
    }
  });

  it.each(names)("%s: an unexpected failure is a generic Arabic 500 with no exception text", async (name) => {
    routes[name].fn().mockRejectedValueOnce(new Error("synthetic internal detail"));
    const response = await routes[name].run();
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.message).toMatch(arabic);
    expect(JSON.stringify(payload)).not.toContain("synthetic internal detail");
  });
});
