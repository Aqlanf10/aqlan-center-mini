import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn(), revalidateSessionInTransaction: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getCephStudy: vi.fn(), completeCephAnalysis: vi.fn(), discardCephAnalysis: vi.fn(),
  createCephAnalysis: vi.fn(), duplicateCephAnalysis: vi.fn(), listPatientCephAnalyses: vi.fn(),
  updateCephCalibration: vi.fn(), updateCephLandmarks: vi.fn(), updateCephDiagnosis: vi.fn(),
  getPatient: vi.fn(), getSettingsSafe: vi.fn(),
}));
vi.mock("@/lib/ai", () => ({ aiChat: vi.fn(), getAiSettings: vi.fn() }));
vi.mock("@/lib/ceph", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ceph")>(),
  suggestLandmarks: vi.fn(), computeAll: vi.fn(), generateCephExpertDiagnosis: vi.fn(),
}));

import { POST as complete } from "@/app/api/ceph/[id]/complete/route";
import { DELETE as discard, PATCH as patch } from "@/app/api/ceph/[id]/route";
import { POST as create } from "@/app/api/patients/[id]/ceph/route";
import { POST as duplicate } from "@/app/api/ceph/[id]/duplicate/route";
import { POST as analyze } from "@/app/api/ceph/[id]/ai-analyze/route";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { aiChat, getAiSettings } from "@/lib/ai";
import { computeAll, generateCephExpertDiagnosis, suggestLandmarks } from "@/lib/ceph";
import {
  completeCephAnalysis, createCephAnalysis, discardCephAnalysis, duplicateCephAnalysis, getCephStudy,
  listPatientCephAnalyses, updateCephCalibration, updateCephLandmarks, updateCephDiagnosis,
  getPatient, getSettingsSafe, type CephWriteAuthorizer, type DbClient,
} from "@/lib/db";

const arabic = /[؀-ۿ]/;
const ctx = { params: Promise.resolve({ id: "41" }) };
const req = (body: unknown = {}, method = "POST") => new Request("https://synthetic.invalid/x", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const session = { userId: 7, username: "synthetic-doctor", role: "doctor", expiresAt: 4_102_444_800_000,
  credentialVersion: "synthetic-credential-version" };
const createBody = { documentId: 5, phase: "pretreatment", xrayDate: "2025-11-20" };
const calibration = { x1: 0, y1: 0, x2: 100, y2: 0, mm: 25 };
const landmarks = [{ code: "S", x: 12, y: 34, source: "manual" }];
const diagnosis = { finalDx: "تشخيص اصطناعي" };
const study = { analysis: { id: 41, patientId: 101, status: "draft", mmPerPixel: 0.25, xrayDate: "2025-11-20" }, landmarks: [] };
const localExpert = { formatted: { skeletal: "اصطناعي", dental: "اصطناعي", softTissue: "اصطناعي",
  finalDx: "تشخيص اصطناعي", recommendationsText: "توصية اصطناعية محلية" } };

const routes = {
  complete: { run: () => complete(req(), ctx), fn: () => vi.mocked(completeCephAnalysis), optionsAt: 2 },
  discard: { run: () => discard(req({ note: "x" }, "DELETE"), ctx), fn: () => vi.mocked(discardCephAnalysis), optionsAt: 3 },
  duplicate: { run: () => duplicate(req(), ctx), fn: () => vi.mocked(duplicateCephAnalysis), optionsAt: 2 },
  create: { run: () => create(req(createBody), ctx), fn: () => vi.mocked(createCephAnalysis), optionsAt: 0 },
  calibration: { run: () => patch(req({ calibration }, "PATCH"), ctx), fn: () => vi.mocked(updateCephCalibration), optionsAt: 3 },
  landmarks: { run: () => patch(req({ landmarks }, "PATCH"), ctx), fn: () => vi.mocked(updateCephLandmarks), optionsAt: 3 },
  diagnosis: { run: () => patch(req({ diagnosis }, "PATCH"), ctx), fn: () => vi.mocked(updateCephDiagnosis), optionsAt: 3 },
  aiLandmarks: { run: () => analyze(req({ action: "suggest-landmarks", save: true }), ctx),
    fn: () => vi.mocked(updateCephLandmarks), optionsAt: 3 },
  aiDiagnosis: { run: () => analyze(req({ action: "generate-diagnosis", saveToDiagnosis: true, useAiChat: false }), ctx),
    fn: () => vi.mocked(updateCephDiagnosis), optionsAt: 3 },
} as const;
type Name = keyof typeof routes;
const names = Object.keys(routes) as Name[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue(session as never);
  vi.mocked(revalidateSessionInTransaction).mockResolvedValue(session as never);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getCephStudy).mockResolvedValue(study as never);
  vi.mocked(listPatientCephAnalyses).mockResolvedValue([] as never);
  vi.mocked(completeCephAnalysis).mockResolvedValue({ ok: true, measurements: [], summary: "" });
  vi.mocked(discardCephAnalysis).mockResolvedValue({ ok: true });
  vi.mocked(duplicateCephAnalysis).mockResolvedValue({ ok: true, id: 9, replayed: false });
  vi.mocked(createCephAnalysis).mockResolvedValue({ ok: true, id: 9 });
  vi.mocked(updateCephCalibration).mockResolvedValue({ ok: true, mmPerPixel: 0.25 });
  vi.mocked(updateCephLandmarks).mockResolvedValue({ ok: true, count: 1 });
  vi.mocked(updateCephDiagnosis).mockResolvedValue({ ok: true });
  vi.mocked(getPatient).mockResolvedValue({ id: 101, birthYear: 2000, gender: "male" } as never);
  vi.mocked(getSettingsSafe).mockResolvedValue({ "ai.clinical_external": "false" });
  vi.mocked(suggestLandmarks).mockReturnValue({ S: { x: 12, y: 34 } });
  vi.mocked(computeAll).mockReturnValue([]);
  vi.mocked(generateCephExpertDiagnosis).mockReturnValue(localExpert as never);
  vi.mocked(aiChat).mockRejectedValue(new Error("external provider must not be called in this suite"));
  vi.mocked(getAiSettings).mockRejectedValue(new Error("external provider must not be initialized in this suite"));
});
afterEach(() => {
  expect(aiChat).not.toHaveBeenCalled();
  expect(getAiSettings).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const optionsFrom = (name: Name, call: unknown[]) => call[routes[name].optionsAt] as { authorize?: CephWriteAuthorizer };
const optionsOf = (name: Name) => optionsFrom(name, routes[name].fn().mock.calls[0] as unknown[]);

describe("Every existing Ceph write route uses in-transaction authority", () => {
  it.each(names)("%s revalidates current credentials and checks canUploadXrays on the current patient and transaction", async (name) => {
    expect((await routes[name].run()).status).toBeLessThan(300);
    const { authorize } = optionsOf(name);
    expect(authorize).toEqual(expect.any(Function));
    const client = { query: vi.fn() } as unknown as DbClient;
    expect(await authorize!(client, 101)).toBe(true);
    expect(revalidateSessionInTransaction).toHaveBeenLastCalledWith(session, client);
    expect(canAccessPatient).toHaveBeenLastCalledWith(session, 101, "canUploadXrays", client);

    vi.mocked(revalidateSessionInTransaction).mockResolvedValue(null);
    vi.mocked(canAccessPatient).mockClear();
    expect(await authorize!(client, 101)).toBe(false);
    expect(canAccessPatient).not.toHaveBeenCalled();

    vi.mocked(revalidateSessionInTransaction).mockResolvedValue(session as never);
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect(await authorize!(client, 202)).toBe(false);
    expect(canAccessPatient).toHaveBeenLastCalledWith(session, 202, "canUploadXrays", client);
  });

  it.each(names)("%s carries a lock-free expiry recheck for waits after the authorizer", async (name) => {
    await routes[name].run();
    const { authorize } = optionsOf(name);
    expect(authorize?.isCurrent).toEqual(expect.any(Function));
    vi.mocked(revalidateSessionInTransaction).mockClear();
    vi.mocked(canAccessPatient).mockClear();
    const clock = vi.spyOn(Date, "now").mockReturnValue(session.expiresAt + 1);
    try { expect(authorize!.isCurrent!()).toBe(false); }
    finally { clock.mockRestore(); }
    expect(revalidateSessionInTransaction).not.toHaveBeenCalled();
    expect(canAccessPatient).not.toHaveBeenCalled();
  });

  it.each(names)("%s cannot treat its initial patient precheck as permission on a subsequently moved study", async (name) => {
    vi.mocked(canAccessPatient).mockImplementation(async (_session, patientId) => patientId === 101 || patientId === 41);
    const client = { query: vi.fn() } as unknown as DbClient;
    routes[name].fn().mockImplementationOnce((async (...args: unknown[]) => {
      const authorize = optionsFrom(name, args).authorize;
      expect(authorize).toEqual(expect.any(Function));
      return await authorize!(client, 202)
        ? { ok: true, id: 9 }
        : { ok: false, status: 403, message: "لم تعد تملك صلاحية على هذه الدراسة." };
    }) as never);
    const response = await routes[name].run();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: expect.stringMatching(arabic) });
    expect(canAccessPatient).toHaveBeenLastCalledWith(session, 202, "canUploadXrays", client);
  });

  it.each(names)("%s preserves domain 403/404 and Arabic text; an ordinary conflict remains 409", async (name) => {
    for (const status of [403, 404, undefined]) {
      routes[name].fn().mockResolvedValueOnce({ ok: false, status, message: "رسالة عربية من الخادم" } as never);
      const response = await routes[name].run();
      expect(response.status).toBe(status ?? 409);
      expect(await response.json()).toEqual({ message: "رسالة عربية من الخادم" });
    }
  });

  it.each(names)(
    "%s returns a generic Arabic 500 for an unexpected write error without exception text", async (name) => {
      routes[name].fn().mockRejectedValueOnce(new Error("synthetic internal detail"));
      const response = await routes[name].run();
      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.message).toMatch(arabic);
      expect(JSON.stringify(payload)).not.toContain("synthetic internal detail");
    });
});

describe("Existing AI save branches have the same write boundary; local previews stay read-only", () => {
  const actions = [
    { name: "landmarks", body: { action: "suggest-landmarks", save: true }, write: () => vi.mocked(updateCephLandmarks) },
    { name: "diagnosis", body: { action: "generate-diagnosis", saveToDiagnosis: true, useAiChat: false }, write: () => vi.mocked(updateCephDiagnosis) },
  ];

  it.each(actions)("$name refuses a view-only actor before suggestion/provider work or persistence", async ({ body, write }) => {
    vi.mocked(canAccessPatient).mockImplementation(async (_session, _patient, permission) => permission === "canViewXrays");
    vi.mocked(getSettingsSafe).mockResolvedValue({ "ai.clinical_external": "true" });
    const response = await analyze(req({ ...body, useAiChat: true }), ctx);
    expect(response.status).toBe(403);
    expect(write()).not.toHaveBeenCalled();
    expect(getPatient).not.toHaveBeenCalled();
    expect(suggestLandmarks).not.toHaveBeenCalled();
    expect(generateCephExpertDiagnosis).not.toHaveBeenCalled();
    expect(getSettingsSafe).not.toHaveBeenCalled();
  });

  it.each(actions)("$name reports a completed-study refusal rather than claiming a requested save succeeded", async ({ body, write }) => {
    vi.mocked(getCephStudy).mockResolvedValue({ ...study, analysis: { ...study.analysis, status: "completed" } } as never);
    write().mockResolvedValueOnce({ ok: false, message: "التحليل المعتمد لا يُعدَّل." } as never);
    const response = await analyze(req(body), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "التحليل المعتمد لا يُعدَّل." });
    expect(write()).toHaveBeenCalledTimes(1);
    expect(write().mock.calls[0][3]).toEqual({ authorize: expect.any(Function) });
  });

  it.each(actions)("$name preview needs only view permission and never calls a write helper", async ({ body }) => {
    vi.mocked(canAccessPatient).mockImplementation(async (_session, _patient, permission) => permission === "canViewXrays");
    const response = await analyze(req({ ...body, save: false, saveToDiagnosis: false, useAiChat: false }), ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(canAccessPatient).toHaveBeenCalledTimes(1);
    expect(canAccessPatient).toHaveBeenCalledWith(session, 101, "canViewXrays");
    expect(updateCephLandmarks).not.toHaveBeenCalled();
    expect(updateCephDiagnosis).not.toHaveBeenCalled();
  });

  it("saved suggestions retain their suggested source and never invoke completion", async () => {
    const response = await routes.aiLandmarks.run();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, saved: true });
    expect(updateCephLandmarks).toHaveBeenCalledWith(41,
      [{ code: "S", x: 12, y: 34, source: "suggested" }], session.username, { authorize: expect.any(Function) });
    expect(completeCephAnalysis).not.toHaveBeenCalled();
  });
});
