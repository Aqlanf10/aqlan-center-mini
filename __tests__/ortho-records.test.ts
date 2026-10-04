import { describe, expect, it } from "vitest";
import {
  caseRecordSlots, caseRecordStudy, decodeOrthoRecordDocuments, decodeOrthoRecordStudies,
  recordStudyId, type OrthoRecordDocument, type OrthoRecordStudy,
} from "../lib/ortho-records";

const doc = (patch: Partial<OrthoRecordDocument> = {}): OrthoRecordDocument => ({
  id: 11, patientId: 1, orthoCaseId: 100, title: "Synthetic image", isImage: true,
  photoStage: "initial", photoView: "profile", takenOn: null, uploadedAt: "2026-10-04T00:00:00Z", removedAt: null, ...patch,
});
const study = (patch: Partial<OrthoRecordStudy> = {}): OrthoRecordStudy => ({
  id: 81, patientId: 1, orthoCaseId: 100, documentId: 11, status: "draft", phase: "pretreatment", ...patch,
});

describe("exact orthodontic case record projections", () => {
  it("does not let newer prior-case or unassigned photos fill the current case slots", () => {
    const records = [doc({ id: 91, orthoCaseId: 90 }), doc({ id: 92, orthoCaseId: null, photoView: "smile" }), doc()];
    const before = JSON.stringify(records);
    const slots = caseRecordSlots(records, 1, 100, "all");
    expect(slots.get("profile")?.id).toBe(11); expect(slots.has("smile")).toBe(false);
    expect(JSON.stringify(records)).toBe(before);
  });
  it("keeps newest-first selection and exact stage filtering without inventing a stage", () => {
    const records = [doc({ id: 12, photoStage: "progress" }), doc(), doc({ id: 13, photoStage: null, photoView: "smile" })];
    expect(caseRecordSlots(records, 1, 100, "all").get("profile")?.id).toBe(12);
    expect(caseRecordSlots(records, 1, 100, "initial").get("profile")?.id).toBe(11);
    expect(caseRecordSlots(records, 1, 100, "initial").has("smile")).toBe(false);
  });
  it("never promotes foreign, removed, archived, non-image or unknown-view records", () => {
    const records = [doc({ patientId: 2 }), doc({ removedAt: "2026-10-04T01:00:00Z" }),
      doc({ photoStage: "archived" }), doc({ isImage: false }), doc({ photoView: "unknown" })];
    expect(caseRecordSlots(records, 1, 100, "all").size).toBe(0);
  });
  it("requires an exact patient/case/document link to open an analysis", () => {
    const records = [study({ id: 71, orthoCaseId: null }), study({ id: 72, orthoCaseId: 90 }),
      study({ id: 73, patientId: 2 }), study({ id: 74, status: "discarded" }), study()];
    expect(caseRecordStudy(records, 1, 100, 11)?.id).toBe(81);
    expect(caseRecordStudy(records.slice(0, -1), 1, 100, 11)).toBeUndefined();
  });
});

describe("patient-wide record response validation", () => {
  it("supports canonical PostgreSQL BIGSERIAL wire IDs without losing exactness", () => {
    expect(decodeOrthoRecordStudies({ analyses: [{ ...study(), id: "81" }] }, 1)[0].id).toBe(81);
    expect(recordStudyId("81")).toBe(81); expect(recordStudyId(81)).toBe(81);
    expect(() => decodeOrthoRecordStudies({ analyses: [study(), { ...study(), id: "81" }] }, 1)).toThrow();
    for (const invalid of [" 81", "081", "8.1", "8e1", "-81", "9007199254740993", 0, null]) expect(recordStudyId(invalid)).toBeNull();
  });
  it("preserves explicit unassigned and historical references but removes removed/archived images", () => {
    const records = [doc(), doc({ id: 12, orthoCaseId: null }), doc({ id: 13, orthoCaseId: 90 }),
      doc({ id: 14, removedAt: "2026-10-04" }), doc({ id: 15, photoStage: "archived" })];
    expect(decodeOrthoRecordDocuments({ documents: records }, 1).map(row => row.id)).toEqual([11, 12, 13]);
  });
  it.each([{}, null, { documents: {} }, { documents: [doc(), doc()] }, { documents: [doc({ patientId: 2 })] },
    { documents: [{ ...doc(), orthoCaseId: undefined }] }, { documents: [{ ...doc(), orthoCaseId: "100" }] },
    { documents: [{ ...doc(), removedAt: undefined }] }, { documents: [{ ...doc(), isImage: "true" }] }])("rejects unknown document state %j", payload => {
    expect(() => decodeOrthoRecordDocuments(payload, 1)).toThrow();
  });
  it.each([{}, null, { analyses: {} }, { analyses: [study(), study()] }, { analyses: [study({ patientId: 2 })] },
    { analyses: [{ ...study(), orthoCaseId: undefined }] }, { analyses: [{ ...study(), documentId: "11" }] },
    { analyses: [{ ...study(), status: "unknown" }] }])("rejects unknown analysis state %j", payload => {
    expect(() => decodeOrthoRecordStudies(payload, 1)).toThrow();
  });
});
