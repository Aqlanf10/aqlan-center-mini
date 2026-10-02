import { describe, expect, it } from "vitest";
import {
  canCompleteEndo, canMoveEndo, checkCanalDraft, checkEndoAddendum, checkEndoStatusChange,
  checkEndoTreatmentDraft, checkEndoVisitDraft, crownState, endoNextAction, expectedCanals,
  summarizeEndo, type EndoCanalDraft, type EndoVisitRecord,
} from "../lib/endodontics";

const canal = (over: Partial<EndoCanalDraft> & { label: string }): EndoCanalDraft => ({
  workingLengthMm: null, referencePoint: null, measurementMethod: null, masterApicalSize: null,
  taperPercent: null, instrumentation: null, obturated: false, note: null, ...over,
});
const visit = (id: number, over: Partial<EndoVisitRecord> = {}): EndoVisitRecord => ({
  id, visitId: 100 + id, doctorId: 1, recordedAt: "2026-10-01T10:00:00Z", signed: false, stage: "assessment",
  chiefComplaint: null, symptoms: null, pulpalDiagnosis: null, apicalDiagnosis: null, vitalityCold: null,
  vitalityHeat: null, vitalityEpt: null, percussion: null, palpation: null, mobilityGrade: null,
  perioFindings: null, previousTreatment: null, radiographicFindings: null, canalsFound: null,
  instrumentation: null, irrigation: null, medicament: null, obturationTechnique: null,
  obturationMaterial: null, restorationAfter: null, complications: null, prognosis: null, nextStep: null,
  nextVisitWeeks: null, note: null, canals: [], ...over,
});

describe("endodontics — treatment draft", () => {
  it("accepts a valid FDI tooth with a case", () => {
    expect(checkEndoTreatmentDraft({ toothCode: 36, caseId: 5 })).toEqual({ ok: true, value: { toothCode: 36, caseId: 5, kind: "initial" } });
    expect(checkEndoTreatmentDraft({ toothCode: "46", caseId: "7", kind: "retreatment" })).toMatchObject({ ok: true, value: { toothCode: 46, kind: "retreatment" } });
  });
  it("rejects bad teeth, missing case and unknown kind with Arabic messages", () => {
    for (const body of [{ toothCode: 19, caseId: 1 }, { toothCode: 36 }, { toothCode: 36, caseId: 1, kind: "x" }, { caseId: 1 }]) {
      const result = checkEndoTreatmentDraft(body as Record<string, unknown>);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("endodontics — canals", () => {
  it("working length needs a reference point and a measurement method", () => {
    expect(checkCanalDraft({ label: "mb", workingLengthMm: 20.5 }).ok).toBe(false);
    const ok = checkCanalDraft({ label: "mb", workingLengthMm: "20.54", referencePoint: "cusp_tip", measurementMethod: "both" });
    expect(ok).toMatchObject({ ok: true, value: { label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" } });
  });
  it("rejects absurd working lengths, bad labels and unknown vocabulary", () => {
    for (const body of [
      { label: "MB", workingLengthMm: 0, referencePoint: "cusp_tip", measurementMethod: "both" },
      { label: "MB", workingLengthMm: 41, referencePoint: "cusp_tip", measurementMethod: "both" },
      { label: "", }, { label: "a b" }, { label: "MB", referencePoint: "nose" }, { label: "MB", measurementMethod: "guess" },
      { label: "MB", masterApicalSize: 3 }, { label: "MB", taperPercent: 30 },
    ]) expect(checkCanalDraft(body).ok).toBe(false);
  });
  it("a canal without a measurement is still valid (found, not yet measured)", () => {
    expect(checkCanalDraft({ label: "MB2" })).toMatchObject({ ok: true, value: { workingLengthMm: null } });
  });
  it("suggests canals by FDI tooth (a hint, not a limit)", () => {
    expect(expectedCanals(16)).toEqual(["MB", "MB2", "DB", "P"]);
    expect(expectedCanals(36)).toEqual(["MB", "ML", "D"]);
    expect(expectedCanals(14)).toEqual(["B", "P"]);
    expect(expectedCanals(11)).toEqual(["C"]);
    expect(expectedCanals(64)).toEqual(["MB", "DB", "P"]);
    expect(expectedCanals(99)).toEqual([]);
  });
});

describe("endodontics — visit draft", () => {
  it("accepts a full assessment", () => {
    const result = checkEndoVisitDraft({
      stage: "assessment", pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess",
      vitalityCold: "negative", percussion: "tender", mobilityGrade: 1, canalsFound: 3, prognosis: "favorable",
      canals: [{ label: "MB" }, { label: "ML" }, { label: "D" }],
    });
    expect(result.ok).toBe(true);
  });
  it("unknown vocabulary is an error, never silently dropped", () => {
    for (const body of [
      { pulpalDiagnosis: "sore" }, { apicalDiagnosis: "x" }, { vitalityCold: "maybe" }, { percussion: "ouch" },
      { stage: "x" }, { prognosis: "great" }, { restorationAfter: "gold" }, { mobilityGrade: 4 }, { canalsFound: 9 },
      { nextVisitWeeks: 60 },
    ]) expect(checkEndoVisitDraft(body).ok).toBe(false);
  });
  it("rejects duplicate canal labels and more canals than declared", () => {
    expect(checkEndoVisitDraft({ canals: [{ label: "MB" }, { label: "mb" }] }).ok).toBe(false);
    expect(checkEndoVisitDraft({ canalsFound: 1, canals: [{ label: "MB" }, { label: "ML" }] }).ok).toBe(false);
    expect(checkEndoVisitDraft({ canals: "x" }).ok).toBe(false);
  });
  it("an invalid canal fails the whole record (no partial acceptance)", () => {
    expect(checkEndoVisitDraft({ canals: [{ label: "MB" }, { label: "ML", workingLengthMm: 99 }] }).ok).toBe(false);
  });
});

describe("endodontics — status and addendum", () => {
  it("terminal states never reopen", () => {
    expect(canMoveEndo("in_progress", "completed")).toBe(true);
    expect(canMoveEndo("completed", "in_progress")).toBe(false);
    expect(canMoveEndo("abandoned", "completed")).toBe(false);
  });
  it("abandoning needs a reason; completing does not", () => {
    expect(checkEndoStatusChange({ status: "abandoned" }).ok).toBe(false);
    expect(checkEndoStatusChange({ status: "abandoned", outcome: "المريض لم يعد" }).ok).toBe(true);
    expect(checkEndoStatusChange({ status: "completed" }).ok).toBe(true);
    expect(checkEndoStatusChange({ status: "in_progress" }).ok).toBe(false);
  });
  it("addendum text is required", () => {
    expect(checkEndoAddendum({ text: "  " }).ok).toBe(false);
    expect(checkEndoAddendum({ text: "تصحيح الطول" })).toEqual({ ok: true, value: "تصحيح الطول" });
  });
});

describe("endodontics — summary across visits (history, not overwrite)", () => {
  const visits = [
    visit(1, { pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess", canalsFound: 3, stage: "assessment" }),
    visit(2, { stage: "shaping", nextStep: "حشو القنوات", nextVisitWeeks: 1 }),
    visit(3, { stage: "obturation", prognosis: "favorable" }),
  ];
  const rows = new Map<number, EndoCanalDraft[]>([
    [1, [canal({ label: "MB" }), canal({ label: "ML" }), canal({ label: "D" })]],
    [2, [
      canal({ label: "MB", workingLengthMm: 20, referencePoint: "cusp_tip", measurementMethod: "both", masterApicalSize: 25, taperPercent: 6 }),
      canal({ label: "ML", workingLengthMm: 19.5, referencePoint: "cusp_tip", measurementMethod: "apex_locator" }),
      canal({ label: "D", workingLengthMm: 21, referencePoint: "cusp_tip", measurementMethod: "both" }),
    ]],
    [3, [canal({ label: "MB", obturated: true }), canal({ label: "ML", workingLengthMm: 20, referencePoint: "cusp_tip", measurementMethod: "both", obturated: true }), canal({ label: "D", obturated: true })]],
  ]);
  it("keeps the latest value per canal and remembers which visit measured it", () => {
    const summary = summarizeEndo(visits, rows);
    const byLabel = Object.fromEntries(summary.canals.map((c) => [c.label, c]));
    expect(byLabel.MB).toMatchObject({ workingLengthMm: 20, masterApicalSize: 25, obturated: true, lastMeasuredVisitId: 2 });
    expect(byLabel.ML).toMatchObject({ workingLengthMm: 20, lastMeasuredVisitId: 3 });
    expect(summary).toMatchObject({
      pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess", prognosis: "favorable",
      canalsFound: 3, sessions: 3, lastStage: "obturation", allCanalsObturated: true,
    });
  });
  it("is order-independent and does not mutate its input", () => {
    const frozen = Object.freeze([...visits].reverse());
    expect(summarizeEndo(frozen, rows).sessions).toBe(3);
  });
  it("empty history is empty, not an error", () => {
    expect(summarizeEndo([], new Map())).toMatchObject({ sessions: 0, canals: [], allCanalsObturated: false, canalsFound: null });
  });
});

describe("endodontics — completion and crown dependency", () => {
  const base = summarizeEndo([visit(1)], new Map([[1, [canal({ label: "MB", workingLengthMm: 20, referencePoint: "cusp_tip", measurementMethod: "both", obturated: true })]]]));
  it("cannot complete without canals, without full obturation, or without a restoration", () => {
    expect(canCompleteEndo(summarizeEndo([], new Map()), "temporary").ok).toBe(false);
    const open = summarizeEndo([visit(1)], new Map([[1, [canal({ label: "MB" })]]]));
    expect(canCompleteEndo(open, "temporary").ok).toBe(false);
    expect(canCompleteEndo(base, "none").ok).toBe(false);
    expect(canCompleteEndo(base, "temporary").ok).toBe(true);
  });
  it("crown state follows the decision and the episode", () => {
    expect(crownState({ status: "in_progress", crownRequired: null, restorative: "temporary" })).toBe("undecided");
    expect(crownState({ status: "in_progress", crownRequired: true, restorative: "temporary" })).toBe("waiting_rct");
    expect(crownState({ status: "completed", crownRequired: true, restorative: "temporary" })).toBe("ready");
    expect(crownState({ status: "completed", crownRequired: false, restorative: "temporary" })).toBe("not_required");
    expect(crownState({ status: "completed", crownRequired: true, restorative: "permanent" })).toBe("planned_done");
  });
  it("next action guides the chairside order: dx → canals → lengths → obturation → restoration", () => {
    const act = (visits: EndoVisitRecord[], rows: Map<number, EndoCanalDraft[]>, restorative: "none" | "temporary" = "none") =>
      endoNextAction({ status: "in_progress", summary: summarizeEndo(visits, rows), restorative, crown: "undecided" });
    expect(act([], new Map())).toMatch(/التقييم/);
    expect(act([visit(1)], new Map())).toMatch(/التشخيص/);
    const dx = visit(1, { pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "normal_apical" });
    expect(act([dx], new Map())).toMatch(/القنوات/);
    expect(act([dx], new Map([[1, [canal({ label: "MB" })]]]))).toMatch(/الأطوال/);
    const measured = canal({ label: "MB", workingLengthMm: 20, referencePoint: "cusp_tip", measurementMethod: "both" });
    expect(act([dx], new Map([[1, [measured]]]))).toMatch(/التشكيل ثم الحشو/);
    expect(act([dx], new Map([[1, [{ ...measured, obturated: true }]]]))).toMatch(/الترميم/);
    expect(endoNextAction({ status: "completed", summary: summarizeEndo([], new Map()), restorative: "temporary", crown: "ready" })).toMatch(/تاج|التاج/);
  });
});
