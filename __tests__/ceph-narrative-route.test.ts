import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCephCompletionWitness, cephProvenanceHash } from "../lib/ceph-completion-provenance";
const m = vi.hoisted(() => ({ study: vi.fn(), save: vi.fn(), ai: vi.fn(), settings: vi.fn(), session: vi.fn(), access: vi.fn(), landmarkSave: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: m.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("../lib/db", () => ({ getCephStudy: m.study, getPatient: async () => ({ birthYear: 2000 }),
  getSettingsSafe: async () => ({ "ai.clinical_external": "true" }), updateCephDiagnosis: m.save, updateCephLandmarks: m.landmarkSave }));
vi.mock("../lib/ai", () => ({ aiChat: m.ai, getAiSettings: m.settings }));
import { POST } from "../app/api/ceph/[id]/ai-analyze/route";
const call = (body: unknown) => POST(new Request("http://localhost/api/ceph/71/ai-analyze", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "71" }) });
beforeEach(() => {
  vi.clearAllMocks(); m.landmarkSave.mockResolvedValue({ ok: true }); m.session.mockResolvedValue({ username: "viewer" }); m.access.mockResolvedValue(true);
  m.study.mockResolvedValue({ analysis: { status: "draft", patientId: 11, mmPerPixel: null }, landmarks: [], measurements: [], diagnosis: { note: "Clinician's original plan", finalDx: "Original diagnosis" } });
  m.settings.mockResolvedValue({ enabled: true, hasKey: true }); m.ai.mockResolvedValue({ ok: true, content: "Four Premolars Extraction" });
});
// Every accepted descriptive request and every rejection must remain local/read-only.
afterEach(() => {
  expect(m.ai).not.toHaveBeenCalled();
  expect(m.settings).not.toHaveBeenCalled();
  expect(m.save).not.toHaveBeenCalled();
  expect(m.landmarkSave).not.toHaveBeenCalled();
});
describe("existing ceph narrative route is descriptive and read only", () => {
  it("cannot re-enable unsafe recommendations via external AI or overwrite clinician notes", async () => {
    const response = await call({ action: "generate-diagnosis", useAiChat: true, saveToDiagnosis: true });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(m.ai).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
    expect(data.expertDiagnosis.treatmentRecommendations.extractionDecision).toBe("not-specified");
    expect(data.aiEnhancedText).toBeNull(); expect(data.savedToDiagnosis).toBe(false);
    expect(data.suggestion.recommendationsText).not.toContain("Four Premolars");
  });
  it("uses sealed values for completed studies and never recomputes a missing archive", async () => {
    const landmarks = [{ code: "S", x: 0, y: 0 }, { code: "N", x: 100, y: 0 }, { code: "A", x: 100, y: 100 }, { code: "B", x: 50, y: 120 }];
    m.study.mockResolvedValue({ analysis: { status: "completed", patientId: 11, mmPerPixel: 0.1 }, landmarks,
      measurements: [{ code: "ANB", value: -3 }], diagnosis: null });
    let data = await (await call({ action: "generate-diagnosis" })).json();
    expect(data.expertDiagnosis.sagittalSkeletal.classification).toBe("Indeterminate");
    expect(data.suggestion.skeletal).toContain("ANB = -3");
    m.study.mockResolvedValue({ analysis: { status: "completed", patientId: 11, mmPerPixel: 0.1 }, landmarks, measurements: [], diagnosis: null });
    data = await (await call({ action: "generate-diagnosis" })).json();
    expect(data.expertDiagnosis.sagittalSkeletal.classification).toBe("Indeterminate");
    expect(m.ai).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
  it("does not classify live values or expose results with unavailable completed integrity", async () => {
    const landmarks = [{code:"S",x:0,y:0},{code:"N",x:10,y:0},{code:"A",x:10,y:10},{code:"B",x:10,y:20}];
    m.study.mockResolvedValue({analysis:{status:"draft",patientId:11,mmPerPixel:1},landmarks,measurements:[]});
    let response = await call({action:"generate-diagnosis"});
    const data = await response.json();
    expect(data.expertDiagnosis.sagittalSkeletal.classification).toBe("Indeterminate");
    expect(data.suggestion.skeletal).toContain("SNA = 90°");
    expect(JSON.stringify(data.suggestion)).not.toContain("المرجع المدمج");
    m.study.mockResolvedValue({analysis:{status:"completed",patientId:11},landmarks,measurements:[{code:"SNA",value:999}],provenance:{state:"integrity_unavailable",reason:"mismatch"}});
    response = await call({action:"generate-diagnosis"}); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("999");
    expect(m.save).not.toHaveBeenCalled(); expect(m.ai).not.toHaveBeenCalled();
  });
  it("reads versioned saved values/units and never current catalog or stamped substitutes", async () => {
    const witness=buildCephCompletionWitness({analysisId:71,actor:{userId:1,username:"Synthetic"},sealedAt:"2026-11-05T00:00:00.000Z",
      snapshot:{patientId:11,documentId:51,refSet:"saved",calibration:{x1:0,y1:0,x2:100,y2:0,mm:10},mmPerPixel:0.1,landmarks:[],diagnosis:null},
      image:{documentId:51,sha256:"a".repeat(64),width:null,height:null},landmarkReviews:[],
      referenceSet:{key:"saved",name:"Saved",version:"v1",population:null,ageMin:null,ageMax:null,sex:null,active:true,values:[]},measurements:[{code:"SNA",value:77.7}]});
    const before=JSON.stringify(witness);
    m.study.mockResolvedValue({analysis:{status:"completed",patientId:11,mmPerPixel:99},landmarks:[],measurements:[{code:"SNA",value:999}],
      provenance:{state:"versioned",witness,witnessSha256:cephProvenanceHash(witness)}});
    const response=await call({action:"generate-diagnosis",saveToDiagnosis:true}); expect(response.status).toBe(200);
    const data=await response.json(); expect(data.suggestion.skeletal).toContain("SNA = 77.7°"); expect(data.suggestion.skeletal).not.toContain("999");
    expect(data.expertDiagnosis.sagittalSkeletal.classification).toBe("Indeterminate"); expect(data.notice).toContain("لا يثبت ذلك أن الطبيب شاهد المصدر");
    expect(data.recommendationMeaning).toBe("no_automated_recommendation_not_a_contraindication");
    expect(m.save).not.toHaveBeenCalled(); expect(JSON.stringify(witness)).toBe(before);
  });
  it("rejects unvalidated automatic template placement without changing any landmarks", async () => {
    const original = Object.freeze([{ code: "S", x: 21, y: 34, source: "manual" }]);
    m.study.mockResolvedValue({ analysis: { status: "draft", patientId: 11, mmPerPixel: null }, landmarks: original, measurements: [], diagnosis: null });
    const response = await call({ action: "suggest-landmarks", imageWidth: 1200, imageHeight: 800, save: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "UNVALIDATED_TEMPLATE", saved: false });
    expect(m.landmarkSave).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
    expect(original[0]).toEqual({ code: "S", x: 21, y: 34, source: "manual" });
  });
  it.each([401, 403])("retains access denial %s", async status => {
    if (status === 401) m.session.mockResolvedValue(null); else m.access.mockResolvedValue(false);
    expect((await call({ action: "generate-diagnosis" })).status).toBe(status);
    expect(m.ai).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
});
