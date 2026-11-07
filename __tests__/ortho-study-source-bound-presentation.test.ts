import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { projectStudyLongitudinalEligibility } from '../lib/ortho-study-longitudinal';
import { readStudyLongitudinalReview, type StudyLongitudinalCompletionV2 } from '../lib/ortho-study-longitudinal-contract';
import { projectStudyRecordedFacts } from '../lib/ortho-case-study-recorded-facts';
import { studyTextPresentation } from '../lib/ortho-study-text-export';
import { illustrateSavedStudy } from '../lib/ortho-study-illustrated';
import { renderStudyTextPptx } from '../lib/ortho-study-pptx';
import { renderIllustratedStudyPptx } from '../lib/ortho-study-illustrated-pptx';
import { StudyLongitudinalDetails } from '../components/OrthoStudyLongitudinalReview';
import { syntheticLongitudinalStudy, rehashSyntheticLongitudinal } from './fixtures/ortho-study-longitudinal';
import { syntheticStudyCephWitness, syntheticWitnessedStudyCephCapture } from './fixtures/ortho-study-ceph-witness';

const expected = (s: ReturnType<typeof syntheticLongitudinalStudy>) => ({ ...s, revisionId: s.id, revisionHash: s.contentHash, authored: s.content.authored });
function sourceBound() {
  const saved = syntheticLongitudinalStudy();
  const payloads = saved.content.sources.map((source, i) => {
    const old = syntheticWitnessedStudyCephCapture(), original = old.completion.witness;
    original.analysisId = source.selection.id; original.recordedPatientId = saved.recordedPatientId; original.snapshot.patientId = saved.recordedPatientId;
    original.image.sha256 = String(i + 1).repeat(64);
    original.measurements.push({ ...structuredClone(original.measurements[0]), code: 'EXT_INDEX', value: 99999994,
      algorithm: { ...original.measurements[0].algorithm, id: 'aqlan-ceph:EXT_INDEX' }, reference: { ...original.measurements[0].reference, origin: 'builtin_definition_fallback' } });
    const witness = { ...original, schemaVersion: 2 as const, sourceIdentityMeaning: 'submitted_source_identity_matches_server_capture' as const,
      sourceReview: { schemaVersion: 1 as const, identity: { schemaVersion: 1 as const, documentId: original.image.documentId, imageSha256: original.image.sha256,
        referenceSetKey: original.referenceSet.key, referenceSetSha256: original.referenceSetSha256,
        engineVersion: original.measurements[0].algorithm.version, engineSourceSha256: original.measurements[0].algorithm.sourceSha256 } } };
    const payload = { ...old, id: source.selection.id, captureVersion: 3 as const, completion: { witness, witnessSha256: journeyContentHash(witness) } };
    source.payload = payload; return payload;
  });
  return { saved: rehashSyntheticLongitudinal(saved), payloads };
}

describe('source-identity-matched saved-study presentation', () => {
  it('retains exact historical capture2 and witness1 hashes and their policy', () => {
    expect(journeyContentHash(syntheticWitnessedStudyCephCapture())).toBe('9de3bf7fe78e791fea86fcfba23cd096f8d7c7915e2e62b9787d597dcf48b545');
    expect(journeyContentHash(syntheticStudyCephWitness())).toBe('531ce8f20a305de77267289185bdd6b5cb1d84366f31887604757c3109920e33');
    expect(projectStudyLongitudinalEligibility(syntheticLongitudinalStudy(), syntheticLongitudinalStudy()).policyVersion).toBe('ortho-ceph-eligibility-v2');
  });
  it('uses a distinct policy, witness2 metadata and unavailable numeric pairs without modifying saved bytes', () => {
    const { saved, payloads } = sourceBound(), before = JSON.stringify(saved);
    const review = projectStudyLongitudinalEligibility(saved, saved), source = review.stages[0].sources[0], witness = payloads[0].completion.witness;
    expect(review.policyVersion).toBe('ortho-ceph-eligibility-v3-source-bound');
    expect(source).toMatchObject({ witness: 'versioned_source_identity_matched', reasons: ['clinical_comparability_not_validated'],
      completion: { schemaVersion: 2, witnessSha256: payloads[0].completion.witnessSha256, sourceIdentityMeaning: witness.sourceIdentityMeaning, sourceReview: witness.sourceReview } });
    expect(review.stages.every(stage => stage.state === 'unavailable' && JSON.stringify(stage.reasons) === '["clinical_comparability_not_validated"]')).toBe(true);
    expect(review.pairs).toHaveLength(6);
    expect(review.pairs.every(pair => pair.delta === null && pair.state === 'unavailable' && JSON.stringify(pair.reasons) === '["clinical_comparability_not_validated"]')).toBe(true);
    expect(readStudyLongitudinalReview(review, expected(saved))).toEqual(review);
    for (const forbidden of ['EXT_INDEX', '99999994', 'source_identity_not_view_bound', 'Synthetic diagnosis', '"value":82', 'landmarkReviews', '"actor"']) expect(JSON.stringify(review)).not.toContain(forbidden);
    expect(JSON.stringify(saved)).toBe(before);
  });
  it('rejects policy/schema/assurance downgrades, extra fields and contradictory identity metadata', () => {
    const { saved } = sourceBound(), review = projectStudyLongitudinalEligibility(saved, saved);
    const matched = (r: typeof review) => r.stages[0].sources[0].completion as StudyLongitudinalCompletionV2;
    const mutations: ((r: typeof review) => void)[] = [
      r => { r.policyVersion = 'ortho-ceph-eligibility-v2'; },
      r => { r.policyVersion = 'ortho-ceph-eligibility-v4' as never; },
      r => { r.stages[0].sources[0].witness = 'versioned_unconfirmed_view'; },
      r => { r.stages[0].sources[0].reasons = ['source_identity_not_view_bound']; },
      r => { r.stages[0].sources[0].completion!.schemaVersion = 1; },
      r => { r.stages[0].sources[0].completion!.sourceIdentityMeaning = 'server_captured_at_completion_not_confirmed_as_viewed'; },
      r => { r.stages[0].sources[0].image!.contentHash = 'f'.repeat(64); },
      r => { r.stages[0].sources[0].completion!.referenceSet.sha256 = 'f'.repeat(64); },
      r => { r.stages[0].sources[0].completion!.algorithms[0].version = 'different-engine'; },
      r => { r.stages[0].sources[0].completion!.algorithms[0].sourceSha256 = 'f'.repeat(64); },
      r => { matched(r).sourceReview.schemaVersion = 2 as never; },
      r => { Object.assign(matched(r).sourceReview, { viewed: true }); },
      r => { matched(r).sourceReview.identity.schemaVersion = 2 as never; },
      r => { matched(r).sourceReview.identity.documentId++; },
      r => { matched(r).sourceReview.identity.documentId = '22' as never; },
      r => { matched(r).sourceReview.identity.engineVersion = ['synthetic-saved-engine'] as never; },
      r => { matched(r).sourceReview.identity.referenceSetKey = 'another-reference'; },
      r => { Object.assign(matched(r).sourceReview.identity, { viewed: true }); },
      r => { delete (matched(r).sourceReview.identity as unknown as Record<string, unknown>).engineSourceSha256; },
      r => { Object.assign(r.stages[0].sources[0].completion!, { sourceReview: null }); },
      r => { Object.assign(r.stages[0].sources[0].completion!, { clinicalValidation: true }); },
      r => { r.pairs[0].delta = 0 as never; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(review); mutate(changed); expect(() => readStudyLongitudinalReview(changed, expected(saved))).toThrow(); }
    const legacy = syntheticLongitudinalStudy(), old = projectStudyLongitudinalEligibility(legacy, legacy);
    old.policyVersion = review.policyVersion;
    expect(() => readStudyLongitudinalReview(old, expected(legacy))).toThrow();
  });
  it('retains distinct evidence semantics in a mixed capture2/capture3/legacy review', () => {
    const { saved } = sourceBound(), capture2 = syntheticWitnessedStudyCephCapture(), legacy = syntheticLongitudinalStudy();
    capture2.id = saved.content.sources[1].selection.id;
    capture2.completion.witness.analysisId = capture2.id;
    capture2.completion.witness.recordedPatientId = saved.recordedPatientId;
    capture2.completion.witness.snapshot.patientId = saved.recordedPatientId;
    capture2.completion.witnessSha256 = journeyContentHash(capture2.completion.witness);
    saved.content.sources[1].payload = capture2; saved.content.sources[2].payload = legacy.content.sources[2].payload;
    const review = projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(saved), saved);
    expect(review.policyVersion).toBe('ortho-ceph-eligibility-v3-source-bound');
    expect(review.stages.map(stage => stage.sources[0].witness)).toEqual(['versioned_source_identity_matched', 'versioned_unconfirmed_view', 'legacy_unversioned', 'versioned_source_identity_matched']);
    expect(review.stages[0].sources[0].reasons).toEqual(['clinical_comparability_not_validated']);
    expect(review.stages[1].sources[0].reasons).toEqual(['source_identity_not_view_bound']);
    expect(review.stages[1].sources[0].completion).not.toHaveProperty('sourceReview');
    expect(review.pairs[0]).toMatchObject({ delta: null, reasons: ['clinical_comparability_not_validated', 'source_identity_not_view_bound'] });
    expect(readStudyLongitudinalReview(review, expected(saved))).toEqual(review);
  });
  it('shows source identity matching without gaze proof, clinical validation, inferred norms or numeric change', () => {
    const { saved, payloads } = sourceBound(), review = projectStudyLongitudinalEligibility(saved, saved);
    const en = renderToStaticMarkup(createElement(StudyLongitudinalDetails, { value: review, locale: 'en' }));
    const ar = renderToStaticMarkup(createElement(StudyLongitudinalDetails, { value: review, locale: 'ar' }));
    expect(en).toContain('Submitted source identity matched the server capture');
    expect(en).toContain('does not prove what the clinician viewed');
    expect(en).toContain('not independent clinical validation');
    expect(en).toContain('Numeric comparison unavailable');
    expect(ar).toContain('تطابقت هوية المصدر المرسلة مع التقاط الخادم');
    const facts = JSON.stringify(projectStudyRecordedFacts(saved.content, saved, 'ceph_panel', 'documented').blocks);
    for (const exact of ['82', '°', 'SNA', 'Synthetic diagnosis', 'synthetic_saved@synthetic-v1', 'synthetic-saved-engine', payloads[0].completion.witness.sourceIdentityMeaning]) expect(facts).toContain(exact);
    for (const text of [en, ar, facts]) for (const forbidden of ['EXT_INDEX', '99999994', 'server_captured_at_completion_not_confirmed_as_viewed', 'المصدر المشاهَد غير مؤكد', 'لكن لم يُثبت أنه المصدر الذي شاهده الطبيب']) expect(text).not.toContain(forbidden);
    expect(facts).toContain('تطابقت هوية المصدر المرسلة مع التقاط الخادم');
    expect(facts).not.toContain('"mean"'); expect(facts).not.toContain('"sd"');
  });
  it('exports the same descriptive metadata as editable PPTX text after privacy filtering', async () => {
    const { saved, payloads } = sourceBound();
    saved.content.authored.panels = saved.content.authored.sources.map((source, i) => ({ instanceId: `panel${i}`, layoutKey: i === 0 ? 'ceph-measurements' : 'visit', included: i !== 2, state: i === 3 ? 'unavailable' : 'available', sourceKeys: [source.key], images: [], comment: '' }));
    saved.content.authored.groups[0].sourceKeys.push('ceph3'); saved.content.authored.groups[2].sourceKeys = [];
    saved.content.authored.groups[3].occurrence.sourceNote = 'PRIVATE_UNAVAILABLE_SOURCE_BOUND_DATE';
    rehashSyntheticLongitudinal(saved);
    const plain = studyTextPresentation(saved, saved), illustrated = await illustrateSavedStudy(saved, saved, async () => { throw Error('No image expected'); });
    const appendix = (pages: typeof plain.pages) => pages.filter(page => page.title.startsWith('أهلية المقارنة السيفالومترية'));
    expect(appendix(illustrated.pages)).toEqual(appendix(plain.pages));
    for (const value of [plain, illustrated]) {
      const text = value.pages.flatMap(page => page.lines).join('');
      for (const exact of ['ortho-ceph-eligibility-v3-source-bound', payloads[0].completion.witnessSha256, 'submitted_source_identity_matches_server_capture', 'تطابقت هوية المصدر المرسلة مع التقاط الخادم', 'T1 → T2']) expect(text).toContain(exact);
      for (const forbidden of ['EXT_INDEX', '99999994', payloads[2].completion.witnessSha256, payloads[3].completion.witnessSha256, 'PRIVATE_UNAVAILABLE_SOURCE_BOUND_DATE', 'T1 → T4', 'مصادر سيفالومترية متعددة', 'server_captured_at_completion_not_confirmed_as_viewed']) expect(text).not.toContain(forbidden);
    }
    for (const bytes of [await renderStudyTextPptx(plain), await renderIllustratedStudyPptx(illustrated)]) {
      const zip = await JSZip.loadAsync(bytes);
      const xml = (await Promise.all(Object.keys(zip.files).filter(key => /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(key)).map(key => zip.file(key)!.async('text')))).join('');
      expect(xml).toContain('<a:t>'); expect(xml).toContain(payloads[0].completion.witnessSha256); expect(xml).toContain('submitted_source_identity_matches_server_capture');
      for (const hidden of ['EXT_INDEX', '99999994', 'ceph3', 'ceph4', payloads[2].completion.witnessSha256, payloads[3].completion.witnessSha256]) expect(xml).not.toContain(hidden);
    }
  });
  it('does not disclose excluded capture3 assurance through export policy or disclaimers', () => {
    const { saved, payloads } = sourceBound(), legacy = syntheticLongitudinalStudy();
    saved.content.sources[0].payload = legacy.content.sources[0].payload;
    saved.content.authored.panels[0].sourceKeys = ['ceph1']; rehashSyntheticLongitudinal(saved);
    const text = studyTextPresentation(saved, saved).pages.flatMap(page => page.lines).join('');
    expect(text).toContain('ortho-ceph-eligibility-v2');
    for (const hidden of ['ortho-ceph-eligibility-v3-source-bound', 'submitted_source_identity_matches_server_capture', payloads[1].completion.witnessSha256]) expect(text).not.toContain(hidden);
  });
});
