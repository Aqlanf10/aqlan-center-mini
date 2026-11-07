import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { studyTextPresentation } from "../lib/ortho-study-text-export";
import { renderStudyTextPptx } from "../lib/ortho-study-pptx";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import type { StudyRevision } from "../lib/ortho-case-study-history";
import type { StudySavedContent } from "../lib/ortho-case-study-capture";
function fixture(): StudyRevision<StudySavedContent> {
  const sources = [1, 2].map(id => ({ key: `doc_${id}`, kind: "document" as const, id, version: null, contentHash: String(id).repeat(64) }));
  const content: StudySavedContent = { schemaVersion: 1, capturedAt: "2026-11-05T00:00:00.000Z", recordedPatientId: 1, orthoCaseId: 2, clinicalCaseId: 3, caseStatusAtCapture: "assessment",
    sources: sources.map(selection => ({ selection, state: "unavailable", unavailableReason: "document_removed", access: { images: true, plans: false }, payload: null })),
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources,
      groups: sources.map((source, index) => ({ id: `timepoint_T${index + 1}`, label: `T${index + 1}`, phase: `T${index + 1}`,
        occurrence: index === 0 ? { occurredOn: null, dateProvenance: "unknown", sourceNote: "synthetic unknown date" } : { occurredOn: "2020-02-29", dateProvenance: "historical_source", sourceNote: "EXCLUDED_SOURCE_NOTE" }, sourceKeys: [source.key] })),
      panels: sources.map((source, index) => ({ instanceId: `visit_${index}`, layoutKey: "visit", included: index === 0, state: "available", sourceKeys: [source.key], images: [], comment: "" })), mediaUses: [], comment: "" } };
  return { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, id: 4, actorId: 5, version: 1, recordedPatientId: 1, schemaVersion: 1, predecessorId: null,
    kind: "draft", documentedFromId: null, baseDocumentedId: null, createdAt: content.capturedAt, reason: "Synthetic", contentHash: journeyContentHash(content), content };
}
describe("saved timepoint export", () => {
  it("prints only explicitly selected stages, unknown dates and recorded source availability", () => {
    const saved = fixture(), before = JSON.stringify(saved), output = studyTextPresentation(saved, saved);
    const text = output.pages.flatMap(page => page.lines).join(" ");
    expect(output.pages.some(page => page.title.includes("T1"))).toBe(true);
    expect(text).toContain("غير معروف"); expect(text).toContain("synthetic unknown date"); expect(text).toContain("غير متاح");
    expect(text).toContain("1".repeat(64)); expect(text).not.toContain("EXCLUDED_SOURCE_NOTE"); expect(text).not.toContain("2020-02-29");
    expect(text).not.toContain("2".repeat(64)); expect(text).not.toContain("تحسن"); expect(JSON.stringify(saved)).toBe(before);
  });
  it("preserves explicit temporal metadata in editable native PPTX", async () => {
    const saved = fixture(); const zip = await JSZip.loadAsync(await renderStudyTextPptx(studyTextPresentation(saved, saved)));
    const slides = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async("text")));
    expect(slides.join(" ")).toContain("T1"); expect(slides.join(" ")).toContain("synthetic unknown date"); expect(slides.join(" ")).not.toContain("EXCLUDED_SOURCE_NOTE");
  });
});
