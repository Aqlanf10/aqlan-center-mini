import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assessmentCommandV2 } from './fixtures/ortho-assessment-schema2';
import { tanakaCommandV2 } from './fixtures/ortho-assessment-tanaka';
import { historicalTanakaPayload } from './fixtures/ortho-assessment-historical-tanaka';
import { syntheticStudyCommand } from './fixtures/ortho-case-study';
import { createPersistedAssessmentV2, assessmentJsonHash, type AssessmentRevisionV2 } from '../lib/ortho-assessment-persisted-v2';
import type { StudySavedContent } from '../lib/ortho-case-study-capture';
import type { StudyRevision } from '../lib/ortho-case-study-history';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { projectStudyRecordedFacts } from '../lib/ortho-case-study-recorded-facts';
import { studyTextPresentation, STUDY_TEXT_RENDERER } from '../lib/ortho-study-text-export';
import { renderStudyTextPptx } from '../lib/ortho-study-pptx';
import { illustrateSavedStudy, STUDY_ILLUSTRATED_RENDERER } from '../lib/ortho-study-illustrated';
import { renderIllustratedStudyPptx } from '../lib/ortho-study-illustrated-pptx';
import { fullStudyPresentation, fullStudyProjectionHash, fullStudyPageNotes, FULL_STUDY_RENDERER, validateFullStudyPresentation } from '../lib/ortho-study-full-layout';
import { renderFullStudyPptx } from '../lib/ortho-study-full-pptx';
import { studyNotesProjectionHash, validateStudyNotesProjection } from '../lib/ortho-study-presentation-notes';
import { checkedStudyPageNotes, modelAnalysisEvidenceHash, type ModelAnalysisEvidence } from '../lib/ortho-study-model-analysis-evidence';

const scope = { patientId: 11, orthoCaseId: 12, clinicalCaseId: 13 };
const noImages = async (): Promise<never> => { throw Error('No synthetic image was selected'); };
function fixture(historical = false): StudyRevision<StudySavedContent> {
  const created = createPersistedAssessmentV2(assessmentCommandV2().content);
  if (!created.ok) throw Error(created.code);
  const content = historical ? historicalTanakaPayload(tanakaCommandV2().content) : created.value;
  const assessment: AssessmentRevisionV2 = { ...scope, id: 14, recordedPatientId: 11, schemaVersion: 2, version: 1,
    supersedesRevisionId: null, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'Synthetic reviewer',
    reason: 'Synthetic saved source', recordingContext: 'current', content, contentHash: assessmentJsonHash(content) };
  const source = { key: 'model_source', kind: 'assessment' as const, id: 14, version: 1, contentHash: assessment.contentHash };
  const authored = syntheticStudyCommand().content; authored.comment = ''; authored.sources = [source];
  authored.panels = [{ instanceId: 'model', layoutKey: 'model-measurements', included: true, state: 'available', sourceKeys: [source.key], images: [], comment: '' }];
  const capture: StudySavedContent = { schemaVersion: 1, capturedAt: '2026-01-02T00:00:00.000Z', recordedPatientId: 11,
    orthoCaseId: 12, clinicalCaseId: 13, caseStatusAtCapture: 'active', authored,
    sources: [{ selection: source, state: 'available', unavailableReason: null, access: { images: false, plans: false }, payload: assessment }] };
  return { ...scope, recordedPatientId: 11, id: 15, schemaVersion: 1, version: 2, predecessorId: 10,
    kind: 'documented', documentedFromId: 10, baseDocumentedId: null, actorId: 16, createdAt: '2026-01-03T00:00:00.000Z',
    reason: 'Synthetic documented copy',
    content: capture, contentHash: journeyContentHash(capture) };
}
function rehash(saved: StudyRevision<StudySavedContent>) { saved.contentHash = journeyContentHash(saved.content); return saved; }
function unescapeXml(text: string) {
  return text.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
async function packageEvidence(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const slides = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const notes = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const text = slides.flatMap(xml => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => unescapeXml(match[1]))).join('').replace(/\s/g, '');
  const decodedNotes = notes.map(xml => JSON.parse(unescapeXml([...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].find(match => unescapeXml(match[1]).startsWith('{'))![1])) as { modelAnalyses: ModelAnalysisEvidence[] });
  return { text, notes: decodedNotes, analyses: decodedNotes.flatMap(note => note.modelAnalyses), pageCount: slides.length };
}

describe('human-readable model results with source-bound exact export notes', () => {
  it.each([false, true])('renders native full/text/illustrated PPTX and preserves historical=%s saved values, inputs and hashes', async historical => {
    const saved = fixture(historical), before = JSON.stringify(saved);
    const facts = projectStudyRecordedFacts(saved.content, scope, 'model', saved.kind);
    const plain = studyTextPresentation(saved, scope), illustrated = await illustrateSavedStudy(saved, scope, noImages);
    const full = await fullStudyPresentation(saved, scope, illustrated);
    expect(facts.modelAnalyses).toHaveLength(historical ? 2 : 4);
    expect(full.pages.flatMap(page => page.modelAnalyses ?? [])).toEqual(facts.modelAnalyses);
    const visible = facts.blocks.flatMap(block => block.kind === 'table' ? block.rows.flatMap(row => row.cells) : [block.text]).join(' ');
    expect(visible).not.toMatch(/width_11|mixed_upper|space_upper|ortho-model|available_minus_required|tanaka_whole_arch/);
    for (const item of facts.modelAnalyses) expect(visible).not.toContain(item.exactWitness.stored.resultHash);
    for (const table of facts.modelTables) {
      const pages = full.pages.filter(page => page.elements.some(element => element.kind === 'table' && element.sourceTableIndex === table.blockIndex));
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every(page => page.title.startsWith(table.title))).toBe(true);
      expect(pages.every(page => page.modelAnalysisId === table.analysisId)).toBe(true);
      const textPages = plain.pages.filter(page => page.title.startsWith(table.title));
      expect(textPages.length).toBeGreaterThan(0);
      expect(textPages.every(page => page.lines[0] === 'حساب محفوظ غير معتمد سريريًا؛ لا يمثل قرارًا علاجيًا.')).toBe(true);
      if (table.analysisId.startsWith('space_')) {
        expect(pages).toHaveLength(1);
        expect(textPages).toHaveLength(1);
        expect(textPages[0].lines.some(line => line.includes('المتاح ناقص المطلوب'))).toBe(true);
      }
    }
    if (!historical) {
      const tables = facts.blocks.filter(block => block.kind === 'table');
      expect(tables).toHaveLength(4);
      expect(Object.fromEntries(tables[0].rows.map(row => row.cells))).toMatchObject({
        'الفك': 'علوي', 'المسافة المتاحة': '70 mm', 'المسافة المطلوبة': '70 mm', 'المتاح ناقص المطلوب': '0 mm',
        'دلالة المعادلة المحفوظة': 'المسافة المتاحة ناقص المسافة المطلوبة (mm)',
      });
      for (const [index, upperSum, reference] of [[2, 42, '77.2 %'], [3, 84, '91.3 %']] as const) {
        expect(Object.fromEntries(tables[index].rows.map(row => row.cells))).toMatchObject({
          'مجموع عروض الأسنان العلوية': `${upperSum} mm`, 'مجموع عروض الأسنان السفلية': `${upperSum} mm`,
          'نسبة السفلي إلى العلوي': '100 %', 'النسبة المرجعية المحفوظة': reference,
        });
        const savedResult = facts.modelAnalyses[index].exactWitness.stored.result;
        if (savedResult.state !== 'ready' || savedResult.witness.result.state !== 'calculated' || !('upperReference' in savedResult.witness.result)) throw Error('Synthetic Bolton result');
        expect(Object.fromEntries(tables[index].rows.map(row => row.cells))).toMatchObject({
          'السفلي ناقص السفلي المتوقع بمرجع علوي': `${savedResult.witness.result.upperReference.lowerMinusExpectedMm} mm`,
          'العلوي ناقص العلوي المتوقع بمرجع سفلي': `${savedResult.witness.result.lowerReference.upperMinusExpectedMm} mm`,
          'المرجع المحفوظ': savedResult.witness.reference!.source,
        });
      }
    }
    const outputs = [await renderStudyTextPptx(plain), await renderIllustratedStudyPptx(illustrated), await renderFullStudyPptx(full)];
    for (const bytes of outputs) {
      const result = await packageEvidence(bytes);
      expect(result.analyses).toEqual(facts.modelAnalyses);
      expect(result.text).not.toMatch(/requiredMm|dependencyObservationIds|formulaVersion|clinicalApproval/);
      expect(result.text).toContain('غيرمعتمدةسريريًا');
      expect(result.text).toContain(historical ? 'المسافةالمطلوبةالمقدّرة' : 'المسافةالمطلوبة');
      for (const evidence of result.analyses) {
        expect(evidence.source).toEqual(saved.content.authored.sources[0]);
        expect(evidence.panelInstanceId).toBe('model');
        expect(evidence.witnessHash).toBe(modelAnalysisEvidenceHash(evidence));
        const assessment = saved.content.sources[0].payload as AssessmentRevisionV2;
        expect(evidence.exactWitness.stored).toEqual(assessment.content.results.find(row => row.analysisId === evidence.exactWitness.selection.id));
        expect(evidence.measurementSet).toEqual(assessment.content.draft.measurementSets[0]);
        expect(evidence.inputs.map(input => input.observationId)).toEqual(evidence.exactWitness.stored.result.dependencyObservationIds);
        for (const input of evidence.inputs) expect(input.observation).toEqual(assessment.content.draft.observations.observations.find(row => row.id === input.observationId) ?? null);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
  it.each(['excluded', 'restricted', 'unavailable', 'not_recorded'] as const)('does not leak %s panel witnesses through notes or visible text', async state => {
    const saved = fixture();
    if (state === 'excluded') saved.content.authored.panels[0].included = false;
    else saved.content.authored.panels[0].state = state;
    if (state === 'not_recorded') saved.content.authored.panels[0].sourceKeys = [];
    saved.content.authored.panels.push({ instanceId: 'empty', layoutKey: 'interview', included: true, state: 'not_recorded', sourceKeys: [], images: [], comment: 'Synthetic visible empty section' });
    rehash(saved);
    const plain = studyTextPresentation(saved, scope), illustrated = await illustrateSavedStudy(saved, scope, noImages), full = await fullStudyPresentation(saved, scope, illustrated);
    for (const value of [plain, illustrated, full]) {
      expect(value.sources).toEqual([]);
      expect(value.pages.flatMap(page => page.modelAnalyses ?? [])).toEqual([]);
      expect(JSON.stringify(value)).not.toContain(saved.content.authored.sources[0].contentHash);
      expect(JSON.stringify(value)).not.toContain('width_11');
    }
  });
  it('binds per-page witnesses to both selected source and panel and rejects tampering before encoding', async () => {
    const saved = fixture(), plain = studyTextPresentation(saved, scope);
    const changed = structuredClone(plain), page = changed.pages.find(page => page.modelAnalyses?.length)!;
    page.modelAnalyses![0].inputs[0].observationId = 'forged_input';
    expect(() => validateStudyNotesProjection(changed)).toThrow('study_presentation_projection_changed');
    changed.projectionHash = studyNotesProjectionHash(changed);
    expect(() => validateStudyNotesProjection(changed)).toThrow('study_model_evidence_invalid');
    const wrongSource = structuredClone(plain), sourcePage = wrongSource.pages.find(page => page.modelAnalyses?.length)!;
    sourcePage.modelAnalyses![0].source.contentHash = 'a'.repeat(64);
    sourcePage.modelAnalyses![0].witnessHash = modelAnalysisEvidenceHash(sourcePage.modelAnalyses![0]);
    wrongSource.projectionHash = studyNotesProjectionHash(wrongSource);
    await expect(renderStudyTextPptx(wrongSource)).rejects.toThrow('study_model_evidence_invalid');
    const full = await fullStudyPresentation(saved, scope, await illustrateSavedStudy(saved, scope, noImages));
    const modelPage = full.pages.find(page => page.modelAnalyses?.length)!;
    modelPage.modelAnalyses![0].panelInstanceId = 'another_panel';
    full.projectionHash = fullStudyProjectionHash(full);
    expect(() => validateFullStudyPresentation(full)).toThrow('full_study_model_analysis_binding');
  });
  it('rejects changed illustrated witness notes when reconstructing the full projection', async () => {
    const saved = fixture(), verified = await illustrateSavedStudy(saved, scope, noImages);
    const evidence = verified.pages.find(page => page.modelAnalyses?.length)!.modelAnalyses![0];
    evidence.exactWitness.selection.id = 'changed';
    await expect(fullStudyPresentation(saved, scope, verified)).rejects.toThrow('full_study_verified_presentation_changed');
  });
  it('snapshots caller-owned note evidence before asynchronous PPTX packaging', async () => {
    const saved = fixture(), plain = studyTextPresentation(saved, scope);
    const illustrated = await illustrateSavedStudy(saved, scope, noImages);
    const full = await fullStudyPresentation(saved, scope, illustrated);
    const expected = structuredClone(plain.pages.flatMap(page => page.modelAnalyses ?? []));
    const pending = [renderStudyTextPptx(plain), renderIllustratedStudyPptx(illustrated), renderFullStudyPptx(full)];
    for (const value of [plain, illustrated, full]) value.pages.find(page => page.modelAnalyses?.length)!.modelAnalyses![0].exactWitness.selection.id = 'MUTATED_AFTER_CALL';
    for (const bytes of await Promise.all(pending)) {
      const evidence = await packageEvidence(bytes);
      expect(evidence.analyses).toEqual(expected);
      expect(JSON.stringify(evidence.notes)).not.toContain('MUTATED_AFTER_CALL');
    }
  });
  it('counts total serialized notes including repeated page evidence before any PPTX encoding', async () => {
    expect(() => checkedStudyPageNotes([{ note: 'x'.repeat(2 * 1024 * 1024) }, { note: 'x'.repeat(2 * 1024 * 1024) }])).toThrow('study_presentation_notes_limit');
    const saved = fixture(), plain = studyTextPresentation(saved, scope), page = plain.pages.find(page => page.modelAnalyses?.length)!;
    plain.pages = Array.from({ length: 300 }, () => structuredClone(page)); plain.projectionHash = studyNotesProjectionHash(plain);
    await expect(renderStudyTextPptx(plain)).rejects.toThrow('study_presentation_notes_limit');
    await expect(renderIllustratedStudyPptx(plain)).rejects.toThrow('study_presentation_notes_limit');
    const full = await fullStudyPresentation(saved, scope, await illustrateSavedStudy(saved, scope, noImages));
    const fullPage = full.pages.find(page => page.modelAnalyses?.length)!;
    full.pages = Array.from({ length: 300 }, () => structuredClone(fullPage)); full.projectionHash = fullStudyProjectionHash(full);
    expect(full.pages.every(page => fullStudyPageNotes(full, page).modelAnalyses.length === 4)).toBe(true);
    await expect(renderFullStudyPptx(full)).rejects.toThrow('study_presentation_notes_limit');
  }, 30_000);
  it('uses new rendering identities without changing captured study/template/source hashes', () => {
    expect(STUDY_TEXT_RENDERER).toBe('ortho-text-v8-readable-model');
    expect(STUDY_ILLUSTRATED_RENDERER).toBe('ortho-illustrated-v8-readable-model');
    expect(FULL_STUDY_RENDERER).toBe('ortho-full-layout-pptx-v2-readable-model');
    const saved = fixture(), before = structuredClone(saved);
    studyTextPresentation(saved, scope);
    expect(saved).toEqual(before);
  });
});
