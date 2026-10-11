import { describe, expect, it, vi } from "vitest";

// Importing or validating retained manifest history must not load any generator,
// converter/PDF library or native image engine. Mock factories fail on access.
vi.mock("pptxgenjs", () => { throw new Error("generator_imported_by_contract"); });
vi.mock("pdf-lib", () => { throw new Error("pdf_library_imported_by_contract"); });
vi.mock("sharp", () => { throw new Error("pixel_engine_imported_by_contract"); });
vi.mock("../lib/ortho-case-presentation-render", () => { throw new Error("renderer_imported_by_contract"); });
vi.mock("../lib/ortho-case-pdf-worker", () => { throw new Error("worker_imported_by_contract"); });

import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_KEY, CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { CASE_TEMPLATE_HASH, caseProjectionHash, caseRenditionSetHash, validateCaseProjection, validateCaseManifest,
  type CaseProjection, type CaseRenderManifest } from "../lib/ortho-case-render-contract";
import { hashBytes, hashJson, textValue } from "../lib/ortho-case-render-security";

const retained = (): { projection: CaseProjection; manifest: CaseRenderManifest } => {
  const projection: CaseProjection = {
    schema: 1, caseId: 1, studyRevisionId: 1, studyRevisionHash: hashBytes("synthetic retained study"),
    capturedAt: "2026-01-01T00:00:00.000Z", language: "ar", state: "draft", privacy: "clinical",
    identity: { patientLabel: "حالة اصطناعية", clinicLabel: "مركز اصطناعي", doctorLabel: "طبيب اصطناعي",
      disclosureId: "synthetic-retained-disclosure", authorityCaptureHash: hashBytes("synthetic captured authority") },
    sources: [], renditions: [],
    panels: [{ instanceId: "cover-1", layoutKey: "cover", state: "available", title: "", occurrenceLabel: "",
      sourceKeys: [], blocks: [], comments: [], media: [] }],
  };
  const manifest: CaseRenderManifest = { id: "synthetic-retained-manifest", caseId: projection.caseId,
    studyRevisionId: projection.studyRevisionId, studyRevisionHash: projection.studyRevisionHash, capturedAt: projection.capturedAt,
    projectionHash: caseProjectionHash(projection), sourceSetHash: hashJson(projection.sources), renditionSetHash: caseRenditionSetHash(projection),
    templateKey: CASE_TEMPLATE_KEY, templateVersion: CASE_TEMPLATE_VERSION, templateHash: CASE_TEMPLATE_HASH };
  return { projection, manifest };
};

describe("retained export contract without render capability", () => {
  it("preserves Arabic and supplementary Unicode while refusing unpaired surrogates", () => {
    for (const value of ["دراسة حالة تقويم", "Synthetic 🦷", "\uD83E\uDDB7"]) expect(() => textValue(value)).not.toThrow();
    for (const value of ["\uD800", "\uDC00", "x\uD800y", "\uDC00\uD800"]) expect(() => textValue(value)).toThrow("invalid_unicode");
  });
  it("validates exact captured projection/manifest without importing render dependencies", () => {
    const { projection, manifest } = retained();
    expect(CASE_TEMPLATE_HASH).toBe(hashJson(CASE_TEMPLATE_IDENTITY));
    expect(() => validateCaseProjection(projection)).not.toThrow();
    expect(() => validateCaseManifest(projection, manifest)).not.toThrow();
  });
  it("still refuses unknown keys and a changed captured projection under the same manifest", () => {
    const { projection, manifest } = retained();
    expect(() => validateCaseProjection({ ...projection, unselected: true } as CaseProjection)).toThrow("invalid_record_keys");
    projection.identity.patientLabel = "هوية اصطناعية أخرى";
    expect(() => validateCaseManifest(projection, manifest)).toThrow("manifest_binding_mismatch");
  });
  it("still rejects a template, source-set or final-rendition-set hash mismatch", () => {
    const { projection, manifest } = retained();
    for (const key of ["templateHash", "sourceSetHash", "renditionSetHash"] as const) {
      expect(() => validateCaseManifest(projection, { ...manifest, [key]: hashBytes("different synthetic binding") })).toThrow("manifest_binding_mismatch");
    }
  });
});
