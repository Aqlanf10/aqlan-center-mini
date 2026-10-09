import { describe, expect, it } from "vitest";
import { legacyCaseKey, readWorkflowCases } from "../lib/patient-workflow-cases";

const PATIENT = 7;
const assessment = (overrides: Record<string, unknown> = {}) => ({
  id: 12, patientId: PATIENT, kind: "specialty", orthoCaseId: null,
  specialty: "endodontics", title: "حالة عصب تحتاج تقييمًا", needsAssessment: true,
  ...overrides,
});
const legacy = (overrides: Record<string, unknown> = {}) => ({
  id: 23, patientId: PATIENT, kind: "specialty", orthoCaseId: null,
  specialty: "periodontics", title: "علاج لثة تاريخي قائم", site: "الفك العلوي",
  status: "active", legacy: true,
  ...overrides,
});
const ortho = (overrides: Record<string, unknown> = {}) => legacy({
  id: null, kind: "ortho", orthoCaseId: 91, specialty: "orthodontics",
  title: "تقويم تاريخي بلا جسر", site: null, status: "waiting",
  ...overrides,
});
const workflow = (assessmentCases: unknown = [assessment()], legacyCases: unknown = [legacy(), ortho()]) => ({
  patient: { id: PATIENT }, assessmentCases, legacyCases,
});

describe("workflow case projection ownership", () => {
  it("accepts valid empty arrays without inventing missing projections", () => {
    expect(readWorkflowCases({ patient: { id: PATIENT }, assessmentCases: [] }, PATIENT))
      .toEqual({ assessmentCases: [], legacyCases: [] });
    expect(readWorkflowCases(workflow([], []), PATIENT, true))
      .toEqual({ assessmentCases: [], legacyCases: [] });
  });

  it("does not require the legacy release field in assessment-only mode", () => {
    expect(readWorkflowCases({ patient: { id: PATIENT }, assessmentCases: [assessment()] }, PATIENT))
      .toEqual({ assessmentCases: [assessment()], legacyCases: [] });
    expect(readWorkflowCases(workflow([assessment()], null), PATIENT))
      .toEqual({ assessmentCases: [assessment()], legacyCases: [] });
  });

  it("requires an explicit assessment array even when legacy projections are valid", () => {
    for (const value of [undefined, null, {}, "", false, 0]) {
      const input = { patient: { id: PATIENT }, assessmentCases: value, legacyCases: [legacy()] };
      expect(readWorkflowCases(input, PATIENT)).toBeNull();
      expect(readWorkflowCases(input, PATIENT, true)).toBeNull();
    }
    expect(readWorkflowCases({ patient: { id: PATIENT }, legacyCases: [] }, PATIENT, true)).toBeNull();
  });

  it("requires an explicit legacy array after opting into the legacy release", () => {
    for (const value of [undefined, null, {}, "", false, 0]) {
      expect(readWorkflowCases({ patient: { id: PATIENT }, assessmentCases: [], legacyCases: value }, PATIENT, true)).toBeNull();
    }
    expect(readWorkflowCases({ patient: { id: PATIENT }, assessmentCases: [] }, PATIENT, true)).toBeNull();
  });

  it("rejects malformed envelopes and missing or foreign patient ownership", () => {
    for (const value of [undefined, null, [], true, "summary", 7,
      {}, { assessmentCases: [] }, { patient: null, assessmentCases: [] },
      { patient: [], assessmentCases: [] }, { patient: {}, assessmentCases: [] },
      { ...workflow(), patient: { id: 8 } }, { ...workflow(), patient: { id: "7" } }]) {
      expect(readWorkflowCases(value, PATIENT)).toBeNull();
      expect(readWorkflowCases(value, PATIENT, true)).toBeNull();
    }
  });

  it("requires positive safe-integer patient IDs even when the envelope and rows agree", () => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const input = { patient: { id }, assessmentCases: [assessment({ patientId: id })], legacyCases: [] };
      expect(readWorkflowCases(input, id)).toBeNull();
      expect(readWorkflowCases(input, id, true)).toBeNull();
    }
  });

  it("rejects foreign patient rows before displaying any valid row", () => {
    expect(readWorkflowCases(workflow([assessment(), assessment({ id: 13, patientId: 8 })]), PATIENT)).toBeNull();
    expect(readWorkflowCases(workflow([assessment()], [legacy(), ortho({ patientId: 8 })]), PATIENT, true)).toBeNull();
    expect(readWorkflowCases(workflow([assessment()], [legacy({ patientId: "7" })]), PATIENT, true)).toBeNull();
  });
});

describe("assessment workflow projection", () => {
  it("returns minimal copied values suitable for the display-only banner", () => {
    const source = assessment({ legacy: false, internalNote: "not part of the banner" });
    const parsed = readWorkflowCases(workflow([source]), PATIENT);
    expect(parsed).toEqual({ assessmentCases: [assessment()], legacyCases: [] });
    expect(parsed!.assessmentCases[0]).not.toBe(source);
    expect(source).toHaveProperty("internalNote");
  });

  it("rejects every malformed member rather than returning an accepted prefix", () => {
    const invalidRows: unknown[] = [null, undefined, [], "case", 7, true,
      assessment({ id: null }), assessment({ id: 0 }), assessment({ id: -1 }),
      assessment({ id: 1.5 }), assessment({ id: "12" }), assessment({ id: Number.NaN }),
      assessment({ id: Number.POSITIVE_INFINITY }), assessment({ id: Number.MAX_SAFE_INTEGER + 1 }),
      assessment({ patientId: undefined }), assessment({ patientId: "7" }),
      assessment({ kind: undefined }), assessment({ kind: "unknown" }), assessment({ kind: "ortho" }),
      assessment({ orthoCaseId: undefined }), assessment({ orthoCaseId: 91 }),
      assessment({ specialty: undefined }), assessment({ specialty: "" }), assessment({ specialty: " \t\n" }),
      assessment({ specialty: 8 }), assessment({ title: null }), assessment({ title: " \t\n" }),
      assessment({ needsAssessment: undefined }), assessment({ needsAssessment: false }),
      assessment({ needsAssessment: "true" }), assessment({ needsAssessment: 1 }),
      assessment({ legacy: true }), assessment({ legacy: "false" }), assessment({ legacy: null }),
      ortho({ needsAssessment: true }),
    ];
    for (const row of invalidRows) {
      expect(readWorkflowCases(workflow([assessment({ id: 99 }), row]), PATIENT)).toBeNull();
    }
    expect(readWorkflowCases(workflow(new Array(1)), PATIENT)).toBeNull();
  });

  it("rejects duplicate assessment identities even when titles or specialties differ", () => {
    expect(readWorkflowCases(workflow([assessment(), assessment({ title: "another title", specialty: "surgery" })]), PATIENT)).toBeNull();
  });
});

describe("legacy workflow projection", () => {
  it("accepts mixed specialty, bridged specialty, and null-ID orthodontic rows", () => {
    const rows = [legacy(), legacy({ id: 24, specialty: "orthodontics", orthoCaseId: 92, site: null }), ortho()];
    const parsed = readWorkflowCases(workflow([assessment()], rows), PATIENT, true);
    expect(parsed).toEqual({ assessmentCases: [assessment()], legacyCases: rows });
    expect(parsed!.legacyCases.map(legacyCaseKey)).toEqual(["case-23", "case-24", "ortho-91"]);
  });

  it("keeps specialty and orthodontic ID namespaces distinct", () => {
    const parsed = readWorkflowCases(workflow([], [legacy({ id: 91 }), ortho()]), PATIENT, true);
    expect(parsed!.legacyCases.map(legacyCaseKey)).toEqual(["case-91", "ortho-91"]);
  });

  it("returns fresh minimal legacy values without mutating the wire response", () => {
    const source = legacy({ internalNote: "not part of the banner" });
    const parsed = readWorkflowCases(workflow([], [source]), PATIENT, true);
    expect(parsed).toEqual({ assessmentCases: [], legacyCases: [legacy()] });
    expect(parsed!.legacyCases[0]).not.toBe(source);
    expect(source).toHaveProperty("internalNote");
  });

  it("rejects malformed discriminants, IDs, flags, text, and non-live status", () => {
    const invalidRows: unknown[] = [null, undefined, [], "case", 7, true,
      legacy({ id: null }), legacy({ id: 0 }), legacy({ id: -1 }), legacy({ id: 1.5 }),
      legacy({ id: "23" }), legacy({ id: Number.NaN }), legacy({ id: Number.MAX_SAFE_INTEGER + 1 }),
      legacy({ patientId: undefined }), legacy({ kind: undefined }), legacy({ kind: "unknown" }),
      legacy({ orthoCaseId: undefined }), legacy({ orthoCaseId: 0 }), legacy({ orthoCaseId: "91" }),
      legacy({ orthoCaseId: 1.5 }), legacy({ specialty: undefined }), legacy({ specialty: "" }),
      legacy({ specialty: " \t" }), legacy({ title: null }), legacy({ title: " \n" }),
      legacy({ site: undefined }), legacy({ site: 12 }), legacy({ status: undefined }),
      legacy({ status: "completed" }), legacy({ status: "closed" }), legacy({ status: "cancelled" }),
      legacy({ status: "unknown" }), legacy({ legacy: undefined }), legacy({ legacy: false }),
      legacy({ legacy: "true" }), legacy({ legacy: 1 }),
      ortho({ id: 91 }), ortho({ id: undefined }), ortho({ orthoCaseId: null }),
      ortho({ orthoCaseId: 0 }), ortho({ orthoCaseId: -1 }), ortho({ orthoCaseId: 1.5 }),
      ortho({ orthoCaseId: "91" }), ortho({ orthoCaseId: Number.POSITIVE_INFINITY }),
      ortho({ orthoCaseId: Number.MAX_SAFE_INTEGER + 1 }), ortho({ specialty: "endodontics" }),
    ];
    for (const row of invalidRows) {
      expect(readWorkflowCases(workflow([assessment()], [legacy({ id: 99 }), row]), PATIENT, true)).toBeNull();
    }
    expect(readWorkflowCases(workflow([], new Array(1)), PATIENT, true)).toBeNull();
  });

  it("rejects duplicate canonical specialty and orthodontic identities", () => {
    expect(readWorkflowCases(workflow([], [legacy(), legacy({ title: "duplicate", orthoCaseId: 92 })]), PATIENT, true)).toBeNull();
    expect(readWorkflowCases(workflow([], [ortho(), ortho({ title: "duplicate", site: "another site" })]), PATIENT, true)).toBeNull();
  });

  it("fails the complete read when either requested projection is invalid", () => {
    expect(readWorkflowCases(workflow([assessment({ needsAssessment: false })], [legacy()]), PATIENT, true)).toBeNull();
    expect(readWorkflowCases(workflow([assessment()], [legacy({ legacy: false })]), PATIENT, true)).toBeNull();
  });
});
