import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { studyTextPresentation } from "../lib/ortho-study-text-export";
import { renderStudyTextPptx } from "../lib/ortho-study-pptx";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import type { StudyRevision } from "../lib/ortho-case-study-history";
import type { StudySavedContent } from "../lib/ortho-case-study-capture";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
function revision(comment = "اصطناعي < & >"): StudyRevision<StudySavedContent> {
  const content: StudySavedContent = { schemaVersion: 1, capturedAt: "2026-11-03T00:00:00.000Z", recordedPatientId: 1, orthoCaseId: 2, clinicalCaseId: 3, caseStatusAtCapture: "retention", sources: [],
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment,
      panels: [{ instanceId: "interview1", layoutKey: "interview", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "" }] } };
  return { ...scope, id: 4, actorId: 5, version: 1, recordedPatientId: 1, schemaVersion: 1, predecessorId: null, kind: "draft", documentedFromId: null, baseDocumentedId: null, createdAt: content.capturedAt, reason: "Synthetic export", contentHash: journeyContentHash(content), content };
}
describe("saved clinical text export", () => {
  it("preserves every Unicode character over continuation pages and keeps missing findings explicit", () => {
    const comment = "ع🙂".repeat(1200), saved = revision(comment), before = JSON.stringify(saved);
    const output = studyTextPresentation(saved, scope);
    expect(output.pages.length).toBeGreaterThan(1);
    expect(output.pages.every(page => page.lines.length <= 12 && page.lines.every(line => Array.from(line).length <= 100))).toBe(true);
    expect(output.pages.flatMap(page => page.lines).join("")).toContain(comment);
    expect(output.pages[0].lines[0]).toContain("غير مسجل");
    expect(JSON.stringify(saved)).toBe(before);
    expect(output.revisionHash).toBe(saved.contentHash);
  });
  it("refuses an empty or oversized export instead of truncating selected panels", () => {
    const saved = revision("ع".repeat(3500)); saved.content.authored.panels[0].included = false;
    expect(() => studyTextPresentation(saved, scope)).toThrow("study_text_export_empty");
    saved.content.authored.panels = Array.from({ length: 100 }, (_, i) => ({ ...saved.content.authored.panels[0], included: true, layoutKey: "retention", instanceId: `panel_${i}` }));
    expect(() => studyTextPresentation(saved, scope)).toThrow("study_text_export_limit");
  });
  it("produces editable native RTL text and exact revision provenance in Office XML without images", async () => {
    const saved = revision(), value = studyTextPresentation(saved, scope), zip = await JSZip.loadAsync(await renderStudyTextPptx(value));
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("text");
    expect(slide).toContain("<a:t>"); expect(slide).toContain("اصطناعي &lt; &amp; &gt;"); expect(slide).toContain('rtl="1"');
    expect(Object.keys(zip.files).filter(name => /^ppt\/media\/[^/]+$/.test(name))).toEqual([]);
    expect(await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("text")).toContain(saved.contentHash);
  });
});
