import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route and explicit-config AI implementation are real. Clinical read
// boundaries are synthetic; writes/audit and outbound transport are fail-closed
// mocks. This is a no-domain-write unit witness, not a SQL READ ONLY proof of
// common ensureSchema startup or a real provider/clinical-data transmission.
const boundary = vi.hoisted(() => ({
  getCephStudy: vi.fn(), getPatient: vi.fn(), getSettingsSafe: vi.fn(),
  query: vi.fn(), write: vi.fn(), audit: vi.fn(),
  fetch: vi.fn(), decrypt: vi.fn(), canAccess: vi.fn(), session: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  getCephStudy: boundary.getCephStudy, getPatient: boundary.getPatient, getSettingsSafe: boundary.getSettingsSafe,
  getPool: () => ({ query: boundary.query }), recordAudit: boundary.audit,
  updateCephLandmarks: boundary.write, updateCephDiagnosis: boundary.write,
  completeCephAnalysis: boundary.write, updateCephCalibration: boundary.write,
  createCephAnalysis: boundary.write, duplicateCephAnalysis: boundary.write, discardCephAnalysis: boundary.write,
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccess }));
vi.mock("@/lib/secretbox", () => ({ decryptSecret: boundary.decrypt, maskKey: () => "synthetic-mask", encryptSecret: vi.fn(() => { throw new Error("unexpected secret write"); }) }));
vi.mock("@/lib/safe-outbound-url", () => ({ assertSafeOutboundUrl: vi.fn(async () => ({ ok: true })) }));
// If aiChat accidentally loses its explicit config and reaches the provider
// registry, the test must fail rather than hide a usage/health persistence path.
vi.mock("@/lib/ai-providers/registry", () => ({ executeAiChatWithFallback: vi.fn(async () => { throw new Error("unexpected provider-registry fallback"); }) }));

import { POST } from "@/app/api/ceph/[id]/ai-analyze/route";
import { AUDIT_EXEMPT } from "@/lib/audit-coverage";
import { executeAiChatWithFallback } from "@/lib/ai-providers/registry";
import { assertSafeOutboundUrl } from "@/lib/safe-outbound-url";
const study = {
  analysis: { id: 41, patientId: 101, documentId: 5, status: "draft", orthoCaseId: null,
    phase: "pretreatment", xrayDate: null, refSet: "builtin_default", calibration: null, mmPerPixel: null,
    createdBy: "synthetic-doctor", createdAt: "2026-01-01T00:00:00.000Z", correctedBy: [] },
  landmarks: [], measurements: [], diagnosis: null,
};
const request = (body: unknown) => new Request("https://synthetic.invalid/api/ceph/41/ai-analyze", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const context = { params: Promise.resolve({ id: "41" }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(assertSafeOutboundUrl).mockResolvedValue({ ok: true });
  boundary.session.mockResolvedValue({ userId: 7, username: "synthetic-doctor", role: "doctor", credentialVersion: "synthetic-version" });
  boundary.canAccess.mockResolvedValue(true);
  boundary.getCephStudy.mockImplementation(async () => structuredClone(study));
  boundary.getPatient.mockResolvedValue({ id: 101, birthYear: null, gender: null });
  boundary.getSettingsSafe.mockResolvedValue({ "ai.clinical_external": "false" });
  boundary.query.mockImplementation(async (sql: string) => {
    if (!/^\s*SELECT\s/i.test(sql) || !/FROM ai_settings WHERE id = 1/.test(sql)) throw new Error("unexpected persistence or SQL path");
    return { rows: [{ enabled: true, provider: "custom", base_url: "https://synthetic.invalid/v1", model: "synthetic",
      api_key_enc: "synthetic-encrypted-marker", last_test_at: null, last_test_ok: null, last_test_message: null,
      updated_by: null, updated_at: null }] };
  });
  boundary.write.mockImplementation(() => { throw new Error("unexpected clinical write"); });
  boundary.audit.mockImplementation(() => { throw new Error("unexpected audit persistence"); });
  boundary.decrypt.mockReturnValue("synthetic-noncredential-marker");
  boundary.fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "مسودة اصطناعية للاختبار" } }] }) });
  vi.stubGlobal("fetch", boundary.fetch);
});
afterEach(() => {
  expect(boundary.write).not.toHaveBeenCalled();
  expect(boundary.audit).not.toHaveBeenCalled();
  expect(executeAiChatWithFallback).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("Ceph preview audit classification", () => {
  it("uses the existing narrow reasoned read-only POST policy", () => {
    expect(AUDIT_EXEMPT["POST /api/ceph/[id]/ai-analyze"]).toContain("ceph.update");
    expect(AUDIT_EXEMPT["POST /api/ceph/[id]/ai-analyze"]).toContain("طلب الحفظ المباشر مرفوض");
  });
  it.each([
    { action: "suggest-landmarks", imageWidth: 1600, imageHeight: 1600 },
    { action: "generate-diagnosis" },
  ])("$action preview returns a draft without persistence or a provider call", async body => {
    const response = await POST(request(body), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provenance: { state: "draft" } });
    expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { action: "suggest-landmarks", save: true },
    { action: "generate-diagnosis", saveToDiagnosis: true, useAiChat: true },
  ])("$action direct save is rejected before computation or provider settings", async body => {
    boundary.getSettingsSafe.mockResolvedValue({ "ai.clinical_external": "true" });
    const response = await POST(request(body), context);
    expect(response.status).toBe(409);
    expect(boundary.getPatient).not.toHaveBeenCalled(); expect(boundary.getSettingsSafe).not.toHaveBeenCalled();
    expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it("the retained explicit-config provider branch only reads settings and returns its preview", async () => {
    boundary.getSettingsSafe.mockResolvedValue({ "ai.clinical_external": "true" });
    const response = await POST(request({ action: "generate-diagnosis", useAiChat: true }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ aiEnhancedText: "مسودة اصطناعية للاختبار", provenance: { state: "draft", source: "external-text-assistance" } });
    expect(boundary.query).toHaveBeenCalledTimes(1); expect(boundary.fetch).toHaveBeenCalledTimes(1);
    expect(boundary.fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(study.diagnosis).toBeNull(); expect(study.landmarks).toEqual([]); expect(study.measurements).toEqual([]);
  });
  it("provider transport failure returns only the local draft and never records provider state", async () => {
    boundary.getSettingsSafe.mockResolvedValue({ "ai.clinical_external": "true" });
    boundary.fetch.mockRejectedValue(new Error("synthetic transport failure"));
    const response = await POST(request({ action: "generate-diagnosis", useAiChat: true }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ aiEnhancedText: null, provenance: { state: "draft", source: "local-measurement-summary" } });
    expect(boundary.query).toHaveBeenCalledTimes(1); expect(boundary.fetch).toHaveBeenCalledTimes(1);
  });
});
