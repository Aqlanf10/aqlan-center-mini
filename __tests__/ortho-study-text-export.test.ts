import {wrapStudyTextLine} from '../lib/ortho-study-display';
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { studyTextPresentation } from "../lib/ortho-study-text-export";
import { renderStudyTextPptx, isolateStudyDateTokens } from "../lib/ortho-study-pptx";
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
  it("isolates exact ISO dates from RTL prose without changing recorded values", () => {
    expect(isolateStudyDateTokens("التاريخ 2026-11-05 و2026-11-01T00:00:00.000Z")).toBe("التاريخ \u20662026-11-05\u2069 و\u20662026-11-01T00:00:00.000Z\u2069");
  });
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

describe('saved text pagination boundaries',()=>{
  it.each(['11-12','2024-02-29','2024-02-29T00:00:00.000Z','0.2','SYNTHETIC_ORIGINAL_SESSION_ACTOR'])('keeps short token %s intact near a line boundary',token=>{
    const input='ملاحظة '.repeat(13)+token+' نص محفوظ',lines=wrapStudyTextLine(input);
    expect(lines.join('')).toBe(input);expect(lines.some(line=>line.includes(token))).toBe(true);
    expect(lines.every(line=>Array.from(line).length<=100)).toBe(true);
  });
  it('preserves Arabic combining marks and astral symbols without cutting their graphemes',()=>{
    const input=('عَ🙂').repeat(80),lines=wrapStudyTextLine(input);
    expect(lines.join('')).toBe(input);expect(lines.every(line=>Array.from(line).length<=100)).toBe(true);
    expect(lines.every(line=>!/^\p{Mark}/u.test(line))).toBe(true);
    expect(lines.every(line=>!/[\uD800-\uDBFF]$/.test(line)&&!/^[\uDC00-\uDFFF]/.test(line))).toBe(true);
  });
  it('keeps joined emoji clusters together at continuation boundaries',()=>{
    const family='👩‍👩‍👧‍👦',input='x'.repeat(98)+family.repeat(20),lines=wrapStudyTextLine(input);
    expect(lines.join('')).toBe(input);expect(lines.every(line=>Array.from(line).length<=100)).toBe(true);
    const original=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(input),s=>s.segment);
    const wrapped=lines.flatMap(line=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(line),s=>s.segment));
    expect(wrapped).toEqual(original);
  });
  it('continues long unbroken tokens without dropping or altering a character',()=>{
    const input='a'.repeat(205),lines=wrapStudyTextLine(input);
    expect(lines.map(line=>line.length)).toEqual([100,100,5]);expect(lines.join('')).toBe(input);
  });
  it('refuses a protected token whose trailing combining mark exceeds the line limit',()=>{
    expect(()=>wrapStudyTextLine('1 mmَ',4)).toThrow('study_text_token_limit');
  });
  it('refuses a pathological oversized grapheme explicitly',()=>{
    expect(()=>wrapStudyTextLine('ع'+'َ'.repeat(100))).toThrow('study_text_grapheme_limit');
  });
});

describe('clinical directional tokens',()=>{
  it.each(['-1e-7 mm','+2.50E+3 mm','-1.25 mm','+1.25 mm','0 mm','0.200 mm','−2.50 mm','11-12','21-22','2024-02-29'])('isolates exact token %s in Arabic prose',token=>{
    const input=`الفك العلوي ${token} القيمة المحفوظة`;
    const displayed=isolateStudyDateTokens(input);
    expect(displayed).toBe(`الفك العلوي \u2066${token}\u2069 القيمة المحفوظة`);
    expect(isolateStudyDateTokens(displayed)).toBe(displayed);
    expect(displayed.replace(/[\u2066\u2069]/g,'')).toBe(input);
    const lines=wrapStudyTextLine('ن'.repeat(94)+' '+token+' نهاية');
    expect(lines.join('')).toBe('ن'.repeat(94)+' '+token+' نهاية');
    expect(lines.some(line=>line.includes(token))).toBe(true);
  });
  it('does not nest or cross adjacent date, contact and quantity spans',()=>{
    expect(isolateStudyDateTokens('FDI: 11-12 / -1.25 mm / 2024-02-29')).toBe('FDI: \u206611-12\u2069 / \u2066-1.25 mm\u2069 / \u20662024-02-29\u2069');
  });
});
