import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeAll, generateCephExpertDiagnosis, type MeasurementResult } from "../lib/ceph";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), study: vi.fn(),
  patient: vi.fn(), diagnosisWrite: vi.fn(), landmarkWrite: vi.fn(), ai: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({ getCephStudy: mocks.study, getPatient: mocks.patient,
  updateCephDiagnosis: mocks.diagnosisWrite, updateCephLandmarks: mocks.landmarkWrite }));
vi.mock("@/lib/ai", () => ({ aiChat: mocks.ai, getAiSettings: vi.fn() }));
import { POST } from "../app/api/ceph/[id]/ai-analyze/route";

function row(code: string, value: number | null, extra: Partial<MeasurementResult> = {}): MeasurementResult {
  const template = computeAll({}, NaN).find(r => r.code === code);
  if (!template) throw new Error(`Missing measurement ${code}`);
  return { ...template, value, ...extra };
}
function noTreatment(dx: ReturnType<typeof generateCephExpertDiagnosis>) {
  expect(dx.treatmentRecommendations).toMatchObject({ extractionDecision: "not-specified",
    growthModification: null, expansion: null, anchorageOrTADs: null, orthognathicSurgery: null, narrativePlanAr: "" });
  expect(dx.formatted.recommendationsText).toBe("");
}
function unknown(dx: ReturnType<typeof generateCephExpertDiagnosis>) {
  expect(dx.sagittalSkeletal).toMatchObject({ classification: "Indeterminate", severity: "unknown", maxilla: "unknown", mandible: "unknown" });
  expect(dx.verticalSkeletal.pattern).toBe("Indeterminate");
  expect(dx.verticalSkeletal.descriptionAr).toContain("غير محددة");
  expect(dx.dentalAnalysis).toMatchObject({ upperIncisor: "unknown", lowerIncisor: "unknown" });
  expect(dx.dentalAnalysis.interincisalAr).toContain("غير مقاسة");
  expect(dx.aestheticProfile.profileTypeAr).toContain("غير محدد");
  expect(dx.aestheticProfile.lipCompetenceAr).toContain("فحصاً سريرياً");
  noTreatment(dx);
}

describe("retired ceph inference cannot manufacture normality or treatment", () => {
  it("keeps an empty and an uncalibrated empty study unknown", () => {
    unknown(generateCephExpertDiagnosis([]));
    unknown(generateCephExpertDiagnosis(computeAll({}, NaN)));
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite input %s throughout the legacy description", value => {
    unknown(generateCephExpertDiagnosis(computeAll({}, NaN).map(r => ({ ...r, value }))));
  });
  it("does not borrow reference-pending, retired or duplicated rows", () => {
    unknown(generateCephExpertDiagnosis([
      row("ANB", 8, { referencePending: true }), row("SNA", 90, { retired: true }),
      row("SNB", 75), row("SNB", 85), row("FMA", 40, { referencePending: true }),
      row("U1NA_A", 35, { referencePending: true }), row("L1NB_A", 35, { referencePending: true }),
    ]));
  });
  it("partial skeletal data does not supply missing dental, profile, lip or growth findings", () => {
    const dx = generateCephExpertDiagnosis([row("SNA", 82)]);
    expect(dx.sagittalSkeletal.maxilla).toBe("normal");
    expect(dx.sagittalSkeletal.mandible).toBe("unknown");
    expect(dx.sagittalSkeletal.severity).toBe("unknown");
    expect(dx.dentalAnalysis.upperIncisor).toBe("unknown");
    expect(dx.verticalSkeletal.growthTendencyAr).toContain("لم يُقيّم");
    expect(dx.aestheticProfile.profileTypeAr).toContain("غير محدد");
    noTreatment(dx);
  });
  it("does not invent a Class II division or growth assessment from ANB or Wits alone", () => {
    for (const measured of [row("ANB", 8), row("WITS", 5)]) {
      const dx = generateCephExpertDiagnosis([measured]);
      expect(dx.sagittalSkeletal.classification).toBe("Class II");
      expect(dx.dentalAnalysis.upperIncisor).toBe("unknown");
      expect(dx.aestheticProfile.profileTypeAr).toContain("غير محدد");
      expect(dx.verticalSkeletal.growthTendencyAr).toContain("لم يُقيّم");
      noTreatment(dx);
    }
  });
  it.each([undefined, 9, 14, 24, NaN])("age %s never authorizes extraction, expansion, growth, TADs or surgery", age => {
    for (const anb of [-8, 0, 8]) {
      noTreatment(generateCephExpertDiagnosis([
        row("ANB", anb), row("SNA", 74), row("SNB", 72), row("FMA", 40),
        row("U1NA_A", 35), row("L1NB_A", 40), row("IMPA", 110), row("E_LINE_UL", 5),
      ], { age }));
    }
  });
});

describe("retired ceph generation endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
    mocks.access.mockResolvedValue(true);
    mocks.study.mockResolvedValue({ analysis: { patientId: 11, status: "draft" }, landmarks: [] });
  });
  const request = (body: unknown) => POST(new Request("http://localhost/api/ceph/7/ai-analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "7" }) });
  it.each([{}, { useAiChat: true }, { saveToDiagnosis: true }, { saveToDiagnosis: true, save: true, useAiChat: true }])(
    "refuses old-client inference flags %j without network or writes", async flags => {
      const res = await request({ action: "generate-diagnosis", ...flags });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "clinical_review_required" });
      expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 11, "canViewXrays");
      for (const fn of [mocks.ai, mocks.diagnosisWrite, mocks.landmarkWrite, mocks.patient]) expect(fn).not.toHaveBeenCalled();
    });
  it("preserves authentication and patient authorization refusals", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await request({ action: "generate-diagnosis" })).status).toBe(401);
    expect(mocks.study).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue({ username: "unrelated-doctor", role: "doctor" });
    mocks.access.mockResolvedValue(false);
    expect((await request({ action: "generate-diagnosis", saveToDiagnosis: true })).status).toBe(403);
    expect(mocks.diagnosisWrite).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
  it.each([null, [], 4, "generate-diagnosis"])("rejects malformed body %j", async body => {
    expect((await request(body)).status).toBe(400);
    expect(mocks.study).not.toHaveBeenCalled();
  });
});
