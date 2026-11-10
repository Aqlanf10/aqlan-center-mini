import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ALL_SETTING_KEYS, type SettingsMap } from '../lib/settings';
const syntheticSettings = Object.fromEntries(ALL_SETTING_KEYS.map(key => [key, ''])) as SettingsMap;
import { assessmentCommandV2 } from './fixtures/ortho-assessment-schema2';
import { tanakaCommandV2 } from './fixtures/ortho-assessment-tanaka';
import { historicalTanakaPayload } from './fixtures/ortho-assessment-historical-tanaka';
import { syntheticStudyCommand } from './fixtures/ortho-case-study';
import { createPersistedAssessmentV2, assessmentJsonHash, type AssessmentRevisionV2 } from '../lib/ortho-assessment-persisted-v2';
import { hashBytes } from '../lib/ortho-case-render-security';
import { renderStudyImage } from '../lib/ortho-study-image-processor';
import { defaultOrthoMediaRecipe } from '../lib/ortho-study-media';
import { renderToStaticMarkup } from 'react-dom/server';
import { CASE_LAYOUTS, CASE_TEMPLATE_VERSION } from '../lib/ortho-case-template';
import { STUDY_TEMPLATE_HASH } from '../lib/ortho-case-study-template';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { fullStudyPresentation, fullStudyProjectionHash, fullStudyTablePages, FULL_STUDY_BODY } from '../lib/ortho-study-full-layout';
import { illustrateSavedStudy } from '../lib/ortho-study-illustrated';
import { prepareFullStudyPrint, validateFullStudyPrint, FULL_STUDY_PRINT } from '../lib/ortho-study-full-print';
import { OrthoFullStudyPrintPages } from '../components/OrthoFullStudyPrintPages';
import type { StudySavedContent } from '../lib/ortho-case-study-capture';
import type { StudyRevision } from '../lib/ortho-case-study-history';
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
async function full(layouts?: string[]) { const revision=saved(layouts); return fullStudyPresentation(revision,scope,await illustrateSavedStudy(revision,scope,async()=>{throw Error('No image selected');})); }

async function imageFixture() {
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

function modelSaved(historical = false): StudyRevision<StudySavedContent> {
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

describe('separate browser print adapter for the verified full projection',()=>{
  it('retains all27 layouts, repeated visits, one capture prefix and source order without changing PPTX projection',async()=>{
    const original=await full([...CASE_LAYOUTS.map(layout=>layout.key),'visit']), before=structuredClone(original);
    const printed=prepareFullStudyPrint(original);
    expect(original).toEqual(before); expect(printed.sourceProjectionHash).toBe(original.projectionHash);
    expect([...new Set(printed.sheets.map(sheet=>sheet.sourcePageIndex))]).toEqual(original.pages.map((_,index)=>index));
    expect(printed.sheets.filter(sheet=>sheet.title==='سياق التقاط الدراسة المحفوظة')).toHaveLength(1);
    expect(printed.sheets.filter(sheet=>sheet.title.includes('زيارة')).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(printed)).not.toMatch(/modelAnalyses|exactWitness|patientName/);
    expect(printed.sheets.flatMap(sheet=>sheet.elements).filter(element=>element.kind==='text').map(element=>element.text).join('')).toContain('غير مسجل');
    validateFullStudyPrint(printed);
    original.pages[0].title='CHANGED_AFTER_PREPARATION'; expect(JSON.stringify(printed)).not.toContain('CHANGED_AFTER_PREPARATION');
  });
  it('reconstructs every cell and original source row/field/fragment after longer print continuation',async()=>{
    const original=await full(['interview']);
    const headers=Array.from({length:12},(_,i)=>`الحقل ${i}`), rows=Array.from({length:2},(_,row)=>headers.map((_,col)=>col===10 ? `source${row}col${col} `+'LONG'.repeat(1100):`row${row}col${col} 2.5 mm`));
    const tables=fullStudyTablePages(headers,rows,FULL_STUDY_BODY,[]);
    original.pages=tables.map((table,index)=>({...original.pages[1], title:`Synthetic table ${index}`, elements:[table]}));
    original.projectionHash=fullStudyProjectionHash(original);
    const printed=prepareFullStudyPrint(original);
    for(const [pageIndex,page] of original.pages.entries()) {
      const source=page.elements[0]; if(source.kind!=='table')throw Error('Expected table');
      const children=printed.sheets.filter(sheet=>sheet.sourcePageIndex===pageIndex).flatMap(sheet=>sheet.elements);
      for(const [rowIndex,row] of source.rows.entries()) {
        const reconstructed=row.map(()=>[] as string[]);
        for(const child of children){if(child.kind!=='table')throw Error('Expected native table');
          child.rows.forEach((cells,index)=>{const mapping=child.fragments[index]; if(mapping.sourceRowIndex!==rowIndex)return;
            expect(mapping.sourceFragment).toEqual(source.fragments[rowIndex]);
            if (source.projection === 'row_fields' && mapping.printFragmentIndex > 0 && !cells[0]) expect(child.continuationLabels[index]).toBe(source.rows[rowIndex][0]);
            cells.forEach((cell,col)=>reconstructed[col].push(cell));
          });
        }
        // Repeated field labels are presentation context, never duplicated events.
        reconstructed.forEach((pieces,col)=>expect(pieces.join('\n').replaceAll('\n','')).toBe(row[col].replaceAll('\n','')));
      }
    }
    expect(printed.sheets.length).toBeGreaterThan(original.pages.length);
    expect(printed.sheets.every(sheet=>sheet.continuation>0&&sheet.continuation<=sheet.continuationCount)).toBe(true);
  });
  it('retains only verified cropped PNGs and filtered image provenance, without original/private-source leakage',async()=>{
    const { full: original, bytes } = await imageFixture(); const printed=prepareFullStudyPrint(original);
    const images=printed.sheets.flatMap(sheet=>sheet.elements).filter(element=>element.kind==='image');
    expect(images).toHaveLength(2);
    for(const image of images) {
      const png=Buffer.from(image.dataUrl.split(',')[1],'base64');
      expect(hashBytes(png)).toBe(image.renditionSha256);expect(hashBytes(png)).not.toBe(hashBytes(bytes));
      expect(image.w/image.h).toBeCloseTo(image.width/image.height,8);
      expect(image.x).toBeGreaterThanOrEqual(0);expect(image.y).toBeGreaterThanOrEqual(0);
      expect(image.y+image.h).toBeLessThanOrEqual(FULL_STUDY_PRINT.bodyHeight+.001);
    }
    expect(JSON.stringify(printed)).not.toMatch(/EXCLUDED_PRIVATE|cropPpm|originalUrl/);
    expect(printed.sheets.filter(sheet=>sheet.purpose==='image-provenance').length).toBeGreaterThan(0);
    const html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={printed} settings={syntheticSettings} />);
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).not.toMatch(/EXCLUDED_PRIVATE|modelAnalyses|exactWitness/);
    for (const image of images) { expect(html).toContain(image.sourceSha256); expect(html).toContain(image.renditionSha256); }
  });
  it('keeps model notes server-side, accounts duplicated note bytes, and refuses aggregate4MiB',async()=>{
    const revision=modelSaved(), modelScope={patientId:revision.patientId,orthoCaseId:revision.orthoCaseId,clinicalCaseId:revision.clinicalCaseId};
    const original=await fullStudyPresentation(revision,modelScope,await illustrateSavedStudy(revision,modelScope,async()=>{throw Error('No images');}));
    const printed=prepareFullStudyPrint(original);expect(printed.notesBytes).toBeGreaterThan(10000);
    expect(JSON.stringify(printed)).not.toMatch(/exactWitness|dependencyObservationIds|measurementSet/);
    const html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={printed} settings={syntheticSettings} />);
    expect(html).toContain('حساب غير معتمد سريريًا');expect(html).not.toMatch(/exactWitness|dependencyObservationIds|measurementSet/);
    const evidence=original.pages.find(page=>page.modelAnalyses?.length)!;
    evidence.elements=[{kind:'text',rect:{...FULL_STUDY_BODY},text:'Synthetic notes budget',fontSize:14}];
    original.pages=Array.from({length:300},()=>structuredClone(evidence));original.projectionHash=fullStudyProjectionHash(original);
    expect(()=>prepareFullStudyPrint(original)).toThrow('study_presentation_notes_limit');
  },30000);
  it('refuses changed projection or sheet limit rather than truncating',async()=>{
    const original=await full();original.pages[0].title='tampered';expect(()=>prepareFullStudyPrint(original)).toThrow('full_study_projection_changed');
    const many=await full(['interview']);
    const source=many.pages[0]; source.elements=[{kind:'text',rect:{...FULL_STUDY_BODY},text:Array.from({length:18},()=> 'line').join('\n'),fontSize:14}];
    many.pages=Array.from({length:300},()=>structuredClone(source));many.projectionHash=fullStudyProjectionHash(many);
    expect(()=>prepareFullStudyPrint(many)).toThrow('study_full_print_sheet_limit');
  });
  it('keeps full clinic identity, exact date/source footer, native tables and fail-closed direct-print CSS',async()=>{
    const original=await full(['interview']);
    original.pages[1].elements=fullStudyTablePages(['الحقل','القيمة'],[['مسافة','-2.5 mm']],FULL_STUDY_BODY,[]);
    original.projectionHash=fullStudyProjectionHash(original);
    const value=prepareFullStudyPrint(original),html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={value} settings={{...syntheticSettings,'clinic.name':'Synthetic center','clinic.lead_doctor':'Synthetic doctor','clinic.lead_doctor_title':'Synthetic specialty','clinic.lead_doctor_credentials':'LONG CREDENTIAL '.repeat(18)}} />);
    expect(html).toContain('Synthetic center');expect(html).toContain('Synthetic doctor');expect(html).toContain('Synthetic specialty');expect(html).toContain('LONG CREDENTIAL '.repeat(18));
    expect(html).toContain('<table');expect(html).toContain('-2.5 mm');expect(html).toContain('مسودة');expect(html).toContain('data-print-ready="false"');expect(html).toContain('disabled=""');
    expect(html).toContain(':not([data-print-ready="true"]) .full-print-sheets { display:none!important; }');
    expect(html).toContain('data-study-captured-at');expect(html).toContain(value.capturedAt);expect(html).toContain(value.revisionHash);
    expect(html).not.toMatch(/exactWitness|measurementSet|overflow:\s*hidden/);
    expect(FULL_STUDY_PRINT.bodyHeight).toBe(120);expect(FULL_STUDY_PRINT.height).toBe(190);
  });
});
