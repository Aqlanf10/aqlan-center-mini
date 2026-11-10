import sharp from 'sharp';
import { CASE_TEMPLATE_VERSION } from '../../lib/ortho-case-template';
import { STUDY_TEMPLATE_HASH } from '../../lib/ortho-case-study-template';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { fullStudyPresentation } from '../../lib/ortho-study-full-layout';
import { illustrateSavedStudy } from '../../lib/ortho-study-illustrated';
import { hashBytes } from '../../lib/ortho-case-render-security';
import { renderStudyImage } from '../../lib/ortho-study-image-processor';
import { defaultOrthoMediaRecipe } from '../../lib/ortho-study-media';
import { assessmentCommandV2 } from './ortho-assessment-schema2';
import { tanakaCommandV2 } from './ortho-assessment-tanaka';
import { historicalTanakaPayload } from './ortho-assessment-historical-tanaka';
import { syntheticStudyCommand } from './ortho-case-study';
import { createPersistedAssessmentV2, assessmentJsonHash, type AssessmentRevisionV2 } from '../../lib/ortho-assessment-persisted-v2';
import type { StudySavedContent } from '../../lib/ortho-case-study-capture';
import type { StudyRevision } from '../../lib/ortho-case-study-history';
const scope = { patientId:1, orthoCaseId:2, clinicalCaseId:3 };
function saved(layouts = ['visit', 'visit']): StudyRevision<StudySavedContent> {
  const content: StudySavedContent = { schemaVersion:1, capturedAt:'2026-11-04T00:00:00.000Z', recordedPatientId:1,
    orthoCaseId:2, clinicalCaseId:3, caseStatusAtCapture:'active', sources:[], authored:{
      template:{key:'full-orthodontic-case', version:CASE_TEMPLATE_VERSION, contentHash:STUDY_TEMPLATE_HASH},
      identityDisclosure:'case_only', sources:[], groups:[], mediaUses:[], comment:'',
      panels:layouts.map((layoutKey,index) => ({instanceId:`panel_${index}`, layoutKey, included:true, state:'not_recorded', sourceKeys:[], images:[], comment:`Synthetic visit ${index} — لا توجد صورة مسجلة`})) } };
  return {...scope, id:4, actorId:5, version:1, recordedPatientId:1, schemaVersion:1, predecessorId:null, kind:'draft', documentedFromId:null,
    baseDocumentedId:null, createdAt:content.capturedAt, reason:'Synthetic print', contentHash:journeyContentHash(content), content};
}
export async function full(layouts?: string[]) { const revision=saved(layouts); return fullStudyPresentation(revision,scope,await illustrateSavedStudy(revision,scope,async()=>{throw Error('No image selected');})); }

export async function imageFixture() {
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ee3322' } })
    .composite([{ input: await sharp({ create: { width: 60, height: 80, channels: 3, background: '#2244ee' } }).png().toBuffer(), left: 60, top: 0 }])
    .withMetadata({ orientation: 1 }).png().toBuffer();
  const sourceHash = hashBytes(bytes), revision = saved(['records-overview', 'visit', 'visit']);
  const content = revision.content, selection = { key: 'image', kind: 'document' as const, id: 6, version: null, contentHash: sourceHash };
  const hidden = { key: 'EXCLUDED_PRIVATE_SOURCE', kind: 'document' as const, id: 7, version: null, contentHash: 'b'.repeat(64) };
  content.authored.sources = [selection, hidden];
  content.sources = [{ selection, state: 'available', unavailableReason: null, access: { images: true, plans: false },
    payload: { id: 6, title: 'Synthetic image', mimeType: 'image/png', sizeBytes: bytes.length, contentHash: sourceHash, width: 120, height: 80 } },
  { selection: hidden, state: 'unavailable', unavailableReason: 'document_removed', access: { images: true, plans: false }, payload: null }];
  content.authored.groups = [{ id: 'group1', label: 'Synthetic T1', phase: 'T1', sourceKeys: ['image', hidden.key],
    occurrence: { occurredOn: null, dateProvenance: 'unknown', sourceNote: 'Synthetic date is not known' } }];
  content.authored.mediaUses = ['left', 'right'].map((useId, index) => ({ useId, documentId: 6, sourceSha256: sourceHash,
    groupId: 'group1', slotId: index ? 'face-front' : 'face-profile', order: index, view: 'face-rest',
    caption: index ? 'Synthetic second crop' : 'ع🙂'.repeat(100), recipe: { ...defaultOrthoMediaRecipe(120, 80, 1),
      cropPpm: { top: 0, bottom: 1000000, left: index ? 500000 : 0, right: index ? 1000000 : 500000 } } }));
  content.authored.panels[0] = { ...content.authored.panels[0], state: 'available', sourceKeys: ['image'],
    images: [{ slot: 'face-profile', useId: 'left' }, { slot: 'face-front', useId: 'right' }] };
  content.authored.panels.push({ instanceId: 'excluded', layoutKey: 'visit', included: false, state: 'available', sourceKeys: [hidden.key], images: [], comment: 'EXCLUDED_PRIVATE_COMMENT' });
  revision.contentHash = journeyContentHash(revision.content);
  const verified = await illustrateSavedStudy(revision, scope, (use, frame) => renderStudyImage(bytes, use.recipe, frame));
  return { bytes, revision, verified, full: await fullStudyPresentation(revision, scope, verified) };
}

export function modelSaved(historical = false): StudyRevision<StudySavedContent> {
  const scope = { patientId:11, orthoCaseId:12, clinicalCaseId:13 };
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
