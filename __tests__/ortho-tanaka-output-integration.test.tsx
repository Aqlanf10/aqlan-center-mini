import JSZip from 'jszip';
import {studyTextPresentation} from '../lib/ortho-study-text-export';
import {renderStudyTextPptx} from '../lib/ortho-study-pptx';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {StudyRevision} from '../lib/ortho-case-study-history';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {OrthoAssessmentMeasurementsV2} from '../components/OrthoAssessmentMeasurementsV2';
import OrthoSavedModelReview from '../components/OrthoSavedModelReview';
import {editMeasurementPayloadV2} from '../lib/ortho-assessment-measurement-editor-v2';
import {createPersistedAssessmentV2,assessmentJsonHash,type AssessmentRevisionV2} from '../lib/ortho-assessment-persisted-v2';
import {projectStudyRecordedFacts} from '../lib/ortho-case-study-recorded-facts';
import {CASE_TEMPLATE_VERSION} from '../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../lib/ortho-case-study-template';
import type {StudySavedContent} from '../lib/ortho-case-study-capture';
import type {AssessmentReadResponseV2} from '../lib/ortho-assessment-response-v2';
import {tanakaCommandV2} from './fixtures/ortho-assessment-tanaka';
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3};
function command(){const value=tanakaCommandV2();for(const row of value.content.observations.observations){if(row.id==='available_upper')row.value={state:'measured',value:80};if(row.id==='available_lower')row.value={state:'measured',value:60};}return value;}
function capture(input=command()){
 const content=createPersistedAssessmentV2(input.content);if(!content.ok)throw Error(content.code);
 const revision:AssessmentRevisionV2={...scope,id:4,recordedPatientId:1,schemaVersion:2,version:1,supersedesRevisionId:null,createdAt:'2026-11-06T00:00:00.000Z',createdBy:'Synthetic examiner',reason:'Synthetic output audit',recordingContext:'current',content:content.value,contentHash:assessmentJsonHash(content.value)};
 const data:AssessmentReadResponseV2={ok:true,representation:2,state:'ready',...scope,recordingContext:'current',clinicalWritable:false,history:[revision],revision,sourceStates:[],sources:{items:[],truncated:false,imaging:'restricted'}};
 const selection={key:'assessment',kind:'assessment' as const,id:4,version:1,contentHash:revision.contentHash};
 const study:StudySavedContent={schemaVersion:1,capturedAt:'2026-11-06T00:00:00.000Z',recordedPatientId:1,orthoCaseId:2,clinicalCaseId:3,caseStatusAtCapture:'active',authored:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],groups:[],mediaUses:[],comment:'',panels:[{instanceId:'model',layoutKey:'model-measurements',included:true,state:'available',sourceKeys:['assessment'],images:[],comment:''}]},sources:[{selection,state:'available',unavailableReason:null,access:{images:false,plans:false},payload:revision}]};
 return {revision,data,study};
}
function surfaces(input=command()){
 const draft=editMeasurementPayloadV2(input.content)!;const onChange=vi.fn();const draftHtml=renderToStaticMarkup(<OrthoAssessmentMeasurementsV2 draft={draft} onChange={onChange} sources={[]}/>);
 const {data,study}=capture(input);const savedHtml=renderToStaticMarkup(<OrthoSavedModelReview data={data} expected={{...scope,revisionId:4}}/>);
 const facts=projectStudyRecordedFacts(study,scope,'model','documented');expect(onChange).not.toHaveBeenCalled();return {draftHtml,savedHtml,facts};
}
const text=(html:string)=>html.replace(/<[^>]+>/g,'');
describe('Tanaka output integration with independent specified fixture expectations',()=>{
 // Fixture: lower predictor22, upper incisors30. Upper quadrants22 each =>74 total,
 // available80 =>+6. Lower quadrants21.5 each =>65 total, available60 =>-5.
 // These constants are specified here, never obtained from the production engine.
 it('keeps lower predictor distinct from target incisors and exact arch amounts across draft and saved UI',()=>{
  const {draftHtml,savedHtml}=surfaces();
  const draftUpper=text(draftHtml.split('data-testid="analysis-mixed_upper"')[1]!.split('data-testid="analysis-mixed_lower"')[0]!);
  const draftLower=text(draftHtml.split('data-testid="analysis-mixed_lower"')[1]!);
  const savedUpper=text(savedHtml.split('معرف التحليل mixed_upper')[1]!.split('</article>')[0]!);
  const savedLower=text(savedHtml.split('معرف التحليل mixed_lower')[1]!.split('</article>')[0]!);
  for(const value of [draftUpper,savedUpper])for(const quantity of ['22 mm','30 mm','44 mm','80 mm','74 mm','6 mm'])expect(value).toContain(quantity);
  for(const value of [draftLower,savedLower])for(const quantity of ['22 mm','21.5 mm','43 mm','60 mm','65 mm','-5 mm'])expect(value).toContain(quantity);
  expect(draftUpper).toContain('القواطع السفلية المقاسة: 22 mm');expect(draftUpper).toContain('قواطع الفك المطلوب المقاسة: 30 mm');expect(draftUpper).toContain('تقدير الناب والضاحكين لكل جهة: 22 mm');expect(draftLower).toContain('تقدير الناب والضاحكين لكل جهة: 21.5 mm');expect(savedUpper).toContain('مجموع القواطع السفلية المقاس: 22 mm');expect(savedUpper).toContain('مجموع قواطع الفك المطلوب المقاس: 30 mm');
  expect(savedHtml).toContain('>-5 mm</bdi>');expect(draftHtml).toContain('>-5 mm</bdi>');expect(savedUpper).toContain('ليس عرض كل سن منفرداً');
 });
 it('maps exact arch-specific numbers into saved study table cells, not swapped predictors or summed wrong segments',()=>{
  const {facts}=surfaces();const tables=facts.blocks.filter(b=>b.kind==='table');expect(tables).toHaveLength(2);
  const cells=tables.map(table=>Object.fromEntries(table.rows.map(row=>row.cells)));
  expect(cells[0]).toMatchObject({'الفك':'علوي','مجموع القواطع السفلية المقاس':'22 mm','مجموع قواطع الفك المطلوب المقاس':'30 mm','الناب والضاحكان لكل جهة — تقدير':'22 mm','الناب والضاحكان في الجهتين — تقدير':'44 mm','المسافة المتاحة المقاسة':'80 mm','المسافة المطلوبة المقدّرة':'74 mm','المتاح ناقص المطلوب المقدّر':'6 mm'});
  expect(cells[1]).toMatchObject({'الفك':'سفلي','مجموع القواطع السفلية المقاس':'22 mm','مجموع قواطع الفك المطلوب المقاس':'22 mm','الناب والضاحكان لكل جهة — تقدير':'21.5 mm','الناب والضاحكان في الجهتين — تقدير':'43 mm','المسافة المتاحة المقاسة':'60 mm','المسافة المطلوبة المقدّرة':'65 mm','المتاح ناقص المطلوب المقدّر':'-5 mm'});
 });
 it('gates only the selected target segment and preserves the other arch output',()=>{
  const input=command();input.content.observations.observations.find(row=>row.id==='width_13')!.value={state:'measured',value:7};
  const {draftHtml,savedHtml,facts}=surfaces(input);for(const value of [text(draftHtml),text(savedHtml)]){expect(value).toContain('غير منطبق');expect(value).toContain('-5 mm');}
  const factsText=JSON.stringify(facts.blocks);expect(factsText).toContain('عرض الجزء مسجل كمقاس بالفعل');expect(facts.modelAnalyses[0].exactWitness.stored.result).toMatchObject({state:'inapplicable',reason:'segment_width_already_measured'});expect(factsText).toContain('65 mm');expect(factsText).not.toContain('74 mm');
 });
 it('does not display predicted values outside the saved domain, or call it a normal range',()=>{
  const input=command();for(const row of input.content.observations.observations)if(['width_31','width_32','width_41','width_42'].includes(row.id))row.value={state:'measured',value:7};
  const {draftHtml,savedHtml,facts}=surfaces(input);for(const value of [text(draftHtml),text(savedHtml)]){expect(value).toContain('28 mm');expect(value).not.toContain('المطلوب المقدّر:');}
  expect(savedHtml).toContain('ليس معياراً تشخيصياً أو مدى طبيعياً');expect(JSON.stringify(facts.blocks)).toContain('خارج مجال المدخل التنبؤي المدعوم');expect(facts.modelAnalyses.map(item=>item.exactWitness.stored.result.state)).toEqual(['outside_supported_predictor_domain','outside_supported_predictor_domain']);expect(JSON.stringify(facts.blocks)).not.toContain('المساحة المطلوبة المقدّرة');
 });
 it('preserves signed units and measured/estimated labels through real text and illustrated PPTX generation',async()=>{
  const {study}=capture();const revision:StudyRevision<StudySavedContent>={...scope,id:8,actorId:7,version:1,recordedPatientId:1,schemaVersion:1,predecessorId:null,kind:'draft',documentedFromId:null,baseDocumentedId:null,createdAt:study.capturedAt,reason:'Synthetic output audit',contentHash:journeyContentHash(study),content:study};
  const renderImage=vi.fn(async()=>{throw Error('Image-free fixture must not read images');});
  const outputs=[await renderStudyTextPptx(studyTextPresentation(revision,scope)),await renderIllustratedStudyPptx(await illustrateSavedStudy(revision,scope,renderImage))];
  for(const output of outputs){const zip=await JSZip.loadAsync(output);const slides=await Promise.all(Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name=>zip.file(name)!.async('text')));const xml=slides.join('');for(const value of ['30 mm','22 mm','21.5 mm','44 mm','43 mm','74 mm','65 mm','6 mm','-5 mm'])expect(xml).toContain(`\u2066${value}\u2069`);expect(xml).toContain('المسافة المطلوبة المقدّرة');expect(xml).toContain('مجموع القواطع السفلية المقاس');expect(Object.keys(zip.files).some(name=>/^ppt\/media\/[^/]+$/.test(name))).toBe(false);}
  expect(renderImage).not.toHaveBeenCalled();
 });

});
