import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {projectStudyLongitudinalEligibility} from '../lib/ortho-study-longitudinal';
import {readStudyLongitudinalReview} from '../lib/ortho-study-longitudinal-contract';
import {studyTextPresentation,STUDY_TEXT_RENDERER} from '../lib/ortho-study-text-export';
import {STUDY_ILLUSTRATED_RENDERER} from '../lib/ortho-study-illustrated';
import {syntheticLongitudinalStudy,rehashSyntheticLongitudinal} from './fixtures/ortho-study-longitudinal';
const expected=(s:ReturnType<typeof syntheticLongitudinalStudy>)=>({...s,revisionId:s.id,revisionHash:s.contentHash,authored:s.content.authored});
describe('witnessed presentation boundary',()=>{
 it('versions the response and renderers while preserving legacy limitations',()=>{
  const saved=syntheticLongitudinalStudy(),review=projectStudyLongitudinalEligibility(saved,saved);
  expect(review.policyVersion).toBe('ortho-ceph-eligibility-v2');
  expect(review.stages.every(s=>s.sources.every(v=>v.witness==='legacy_unversioned'&&v.completion===null))).toBe(true);
  expect(STUDY_TEXT_RENDERER).toBe('ortho-text-v6-space-prefix-provenance');
  expect(STUDY_ILLUSTRATED_RENDERER).toBe('ortho-illustrated-v6-space-prefix-provenance');
 });
 it('requires explicit nullable completion metadata and rejects legacy promotion',()=>{
  const saved=syntheticLongitudinalStudy(),review=projectStudyLongitudinalEligibility(saved,saved);
  const changed=structuredClone(review);delete (changed.stages[0].sources[0] as unknown as Record<string,unknown>).completion;
  expect(()=>readStudyLongitudinalReview(changed,expected(saved))).toThrow();
 });
 it('does not leak unavailable panel dates or EXT_INDEX through full text export',()=>{
  const saved=syntheticLongitudinalStudy();saved.content.authored.panels[0].state='unavailable';
  saved.content.authored.groups[0].occurrence.sourceNote='PRIVATE_UNAVAILABLE_DATE';
  const hidden=studyTextPresentation(rehashSyntheticLongitudinal(saved),saved);
  expect(hidden.pages.flatMap(p=>p.lines).join('')).not.toContain('PRIVATE_UNAVAILABLE_DATE');
  const full=studyTextPresentation(syntheticLongitudinalStudy(),saved);
  expect(full.pages.flatMap(p=>p.lines).join('')).not.toContain('EXT_INDEX');
  expect(full.pages.flatMap(p=>p.lines).join('')).not.toContain('99999994');
 });
 it('keeps browser contract free of server witness decoder, crypto, and live reference imports',()=>{
  const source=readFileSync('lib/ortho-study-longitudinal-contract.ts','utf8');
  expect(source).not.toMatch(/from ['"].*(?:ceph-completion-provenance|ortho-study-ceph-capture|journey-hash|node:crypto|\/ceph)['"]/);
 });
});

import {syntheticWitnessedStudyCephCapture} from './fixtures/ortho-study-ceph-witness';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import {projectStudyRecordedFacts} from '../lib/ortho-case-study-recorded-facts';
import {readStudyPanelReview} from '../lib/ortho-case-study-review-contract';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderStudyTextPptx} from '../lib/ortho-study-pptx';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
import JSZip from 'jszip';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {StudyLongitudinalDetails} from '../components/OrthoStudyLongitudinalReview';
function witnessed(){
 const saved=syntheticLongitudinalStudy(),payload=syntheticWitnessedStudyCephCapture(),w=payload.completion.witness;
 payload.id=saved.content.sources[0].selection.id;w.analysisId=payload.id;w.recordedPatientId=saved.recordedPatientId;w.snapshot.patientId=saved.recordedPatientId;
 w.measurements.push({...structuredClone(w.measurements[0]),code:'EXT_INDEX',value:99999994,algorithm:{...w.measurements[0].algorithm,id:'aqlan-ceph:EXT_INDEX'},reference:{...w.measurements[0].reference,origin:'builtin_definition_fallback'}});
 payload.completion.witnessSha256=journeyContentHash(w);saved.content.sources[0].payload=payload;
 return {saved:rehashSyntheticLongitudinal(saved),payload};
}
describe('saved witnessed ceph projection',()=>{
 it('projects bounded exact saved metadata, never raw clinical values or a numeric comparison',()=>{
  const {saved,payload}=witnessed(),before=JSON.stringify(saved),review=projectStudyLongitudinalEligibility(saved,saved),source=review.stages[0].sources[0];
  expect(source.witness).toBe('versioned_unconfirmed_view');expect(source.reasons).toEqual(['source_identity_not_view_bound']);
  expect(source.completion).toEqual({schemaVersion:1,witnessSha256:payload.completion.witnessSha256,sealedAt:payload.completion.witness.sealedAt,
   sourceIdentityMeaning:'server_captured_at_completion_not_confirmed_as_viewed',algorithms:[payload.completion.witness.measurements[0].algorithm],
   referenceSet:{key:'synthetic_saved',version:'synthetic-v1',sha256:payload.completion.witness.referenceSetSha256},
   calibration:{x1:0,y1:0,x2:100,y2:0,mm:10,mmPerPixel:0.1}});
  expect(review.stages.slice(1).every(s=>s.sources[0].completion===null&&s.sources[0].witness==='legacy_unversioned')).toBe(true);
  expect(review.pairs.every(p=>p.state==='unavailable'&&p.delta===null)).toBe(true);
  const text=JSON.stringify(review);for(const forbidden of ['EXT_INDEX','99999994','Synthetic diagnosis','"value":82','populationReference','landmarkReviews','"actor"'])expect(text).not.toContain(forbidden);
  expect(readStudyLongitudinalReview(review,expected(saved))).toEqual(review);expect(JSON.stringify(saved)).toBe(before);
 });
 it('keeps all witnessed stage pairs unavailable and sorts saved algorithms without registry enrichment',()=>{
  const {saved,payload}=witnessed(),w=payload.completion.witness,base=w.measurements[0];
  w.measurements.unshift({...structuredClone(base),code:'HISTORICAL_ONLY',value:17.125,unit:'mm',
   algorithm:{rounding:base.algorithm.rounding,calculationVersion:'historical-calculation',sourceSha256:'c'.repeat(64),version:'older-saved-engine',id:'aqlan-ceph:HISTORICAL_ONLY'},
   reference:{...base.reference,origin:'builtin_definition_fallback',source:'historical-source-code'}});
  payload.completion.witnessSha256=journeyContentHash(w);
  for(let i=1;i<saved.content.sources.length;i++){
   const next=structuredClone(payload);next.id=saved.content.sources[i].selection.id;next.completion.witness.analysisId=next.id;
   next.completion.witnessSha256=journeyContentHash(next.completion.witness);saved.content.sources[i].payload=next;
  }
  const review=projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(saved),saved);
  expect(review.stages.every(stage=>stage.state==='unavailable'&&JSON.stringify(stage.reasons)==='["source_identity_not_view_bound"]')).toBe(true);
  expect(review.pairs).toHaveLength(6);expect(review.pairs.every(pair=>pair.delta===null&&pair.state==='unavailable'&&pair.reasons.length===1)).toBe(true);
  expect(review.stages[0].sources[0].completion!.algorithms.map(a=>a.id)).toEqual(['aqlan-ceph:HISTORICAL_ONLY','aqlan-ceph:SNA']);
  const facts=JSON.stringify(projectStudyRecordedFacts(saved.content,saved,'ceph_panel','documented').blocks);
  for(const savedValue of ['HISTORICAL_ONLY','17.125','mm','older-saved-engine','historical-calculation','historical-source-code'])expect(facts).toContain(savedValue);
  const reversed=structuredClone(review);reversed.stages[0].sources[0].completion!.algorithms.reverse();
  expect(()=>readStudyLongitudinalReview(reversed,expected(saved))).toThrow();
 });
 it('rejects corrupt or future witness bytes even after outer rehash',()=>{
  for(const mutate of [(p:ReturnType<typeof witnessed>['payload'])=>{p.completion.witness.measurements[0].value++;},(p:ReturnType<typeof witnessed>['payload'])=>{p.completion.witness.schemaVersion=2 as never;}]){
   const {saved,payload}=witnessed();mutate(payload);expect(()=>projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(saved),saved)).toThrow();
  }
 });
 it('strictly rejects forged/coerced completion metadata, reasons and legacy promotion',()=>{
  const {saved}=witnessed(),review=projectStudyLongitudinalEligibility(saved,saved);
  const mutations:((r:typeof review)=>void)[]=[r=>{r.stages[0].sources[0].completion!.schemaVersion=2 as never;},r=>{r.stages[0].sources[0].completion!.calibration.mmPerPixel=0.2;},
   r=>{r.stages[0].sources[0].completion!.calibration.x1=Infinity;},r=>{r.stages[0].sources[0].completion!.calibration.mm='10' as never;},
   r=>{Object.assign(r.stages[0].sources[0].completion!,{measurements:[]});},r=>{Object.assign(r.stages[0].sources[0].completion!.algorithms[0],{value:82});},
   r=>{r.stages[0].sources[0].completion!.algorithms.push({...r.stages[0].sources[0].completion!.algorithms[0]});},
   r=>{r.stages[0].sources[0].completion!.algorithms[0].id='aqlan-ceph:EXT_INDEX';},r=>{r.stages[0].sources[0].completion!.referenceSet.key='foreign';},
   r=>{r.stages[0].sources[0].completion!.sourceIdentityMeaning='confirmed_as_viewed' as never;},r=>{r.stages[0].sources[0].image!.state='removed';},
   r=>{r.stages[0].sources[0].status='draft';},r=>{r.stages[1].sources[0].completion=r.stages[0].sources[0].completion;},
   r=>{r.stages[0].sources[0].completion=null;},r=>{r.stages[0].sources[0].reasons=['legacy_completion_witness_missing'];},r=>{r.stages[0].sources[0].witness=['versioned_unconfirmed_view'] as never;}];
  for(const mutate of mutations){const changed=structuredClone(review);mutate(changed);expect(()=>readStudyLongitudinalReview(changed,expected(saved))).toThrow();}
 });
 it('uses exact saved units, algorithm/reference provenance and diagnosis without inferred norms or EXT_INDEX',()=>{
  const {saved}=witnessed(),facts=projectStudyRecordedFacts(saved.content,saved,'ceph_panel','documented'),text=JSON.stringify(facts.blocks);
  for(const exact of ['SNA','82','°','synthetic-saved-engine','synthetic_saved@synthetic-v1','Synthetic diagnosis','server_captured_at_completion_not_confirmed_as_viewed'])expect(text).toContain(exact);
  for(const forbidden of ['EXT_INDEX','99999994','"mean"','"sd"','normal','Sella','improved'])expect(text).not.toContain(forbidden);
  expect(facts.complete).toBe(true);
 });
 it('keeps 256 saved measurement values and provenance within the strict panel-review block bound',()=>{
  const {saved,payload}=witnessed(),w=payload.completion.witness,base=w.measurements[0];
  w.measurements=Array.from({length:256},(_,i)=>({...structuredClone(base),code:`SAVED_${String(i).padStart(3,'0')}`,value:i+0.125,
   algorithm:{...base.algorithm,id:`aqlan-ceph:SAVED_${String(i).padStart(3,'0')}`},reference:{...base.reference,origin:'builtin_definition_fallback'}}));
  payload.completion.witnessSha256=journeyContentHash(w);saved.content.authored.panels[0].sourceKeys=['ceph1'];rehashSyntheticLongitudinal(saved);
  const facts=projectStudyRecordedFacts(saved.content,saved,'ceph_panel','documented'),panel=saved.content.authored.panels[0];
  const bound={patientId:saved.patientId,orthoCaseId:saved.orthoCaseId,clinicalCaseId:saved.clinicalCaseId,revisionId:saved.id,revisionHash:saved.contentHash,
   kind:saved.kind,panelId:panel.instanceId,layoutKey:panel.layoutKey,panelState:panel.state,included:panel.included,comments:[],sourceKeys:panel.sourceKeys};
  const identity={patientId:bound.patientId,orthoCaseId:bound.orthoCaseId,clinicalCaseId:bound.clinicalCaseId,revisionId:bound.revisionId,revisionHash:bound.revisionHash,kind:bound.kind,panelId:bound.panelId,layoutKey:bound.layoutKey,panelState:bound.panelState,included:bound.included,comments:bound.comments};
  const envelope={...identity,ok:true,title:'Synthetic bounded provenance',capturedAt:saved.content.capturedAt,blocks:facts.blocks,
   unavailable:facts.unavailable,unmapped:facts.unmapped,pendingMediaCount:0};
  expect(facts.blocks.length).toBeLessThan(10);expect(()=>readStudyPanelReview(envelope,bound)).not.toThrow();
  const tables=facts.blocks.filter(b=>b.kind==='table');expect(tables.filter(t=>t.rows.length===256)).toHaveLength(2);
  expect(JSON.stringify(facts.blocks)).toContain('SAVED_255');expect(JSON.stringify(facts.blocks)).toContain('255.125');
 });
 it('explains EXT_INDEX-only captures without displaying a blank measurement table',()=>{
  for(const mode of ['legacy','witnessed']){
   const pair=witnessed(),saved=mode==='legacy'?syntheticLongitudinalStudy():pair.saved;
   if(mode==='legacy'){
    const payload=saved.content.sources[0].payload as {measurements:{code:string}[]};payload.measurements=payload.measurements.filter(m=>m.code==='EXT_INDEX');
   }else{
    const w=pair.payload.completion.witness;w.measurements=w.measurements.filter(m=>m.code==='EXT_INDEX');pair.payload.completion.witnessSha256=journeyContentHash(w);
   }
   saved.content.authored.panels[0].sourceKeys=['ceph1'];rehashSyntheticLongitudinal(saved);
   const facts=projectStudyRecordedFacts(saved.content,saved,'ceph_panel','documented'),text=JSON.stringify(facts.blocks);
   expect(text).toContain('مسموحة للعرض');expect(text).not.toContain('EXT_INDEX');expect(text).not.toContain('99999994');
   expect(facts.blocks.some(b=>b.kind==='table'&&b.rows.length===0)).toBe(false);
  }
 });
 it('distinguishes verified immutable record from unconfirmed viewed source in Arabic and English',()=>{
  const {saved}=witnessed(),review=projectStudyLongitudinalEligibility(saved,saved);
  const en=renderToStaticMarkup(createElement(StudyLongitudinalDetails,{value:review,locale:'en'}));
  const ar=renderToStaticMarkup(createElement(StudyLongitudinalDetails,{value:review,locale:'ar'}));
  expect(en).toContain('Verified immutable source record; viewed source unconfirmed');expect(en).toContain('Legacy capture without versioned completion evidence');
  expect(ar).toContain('سجل مصدر ثابت متحقق السلامة');expect(ar).toContain('المصدر المشاهَد غير مؤكد');
  for(const text of [en,ar]){expect(text).toContain('synthetic-saved-engine');expect(text).not.toContain('EXT_INDEX');expect(text).not.toContain('99999994');}
 });
 it('exports witnessed provenance once, native editable text, and filters excluded/unavailable panels before pairs',async()=>{
  const {saved,payload}=witnessed();saved.content.authored.panels=saved.content.authored.sources.map((source,i)=>({instanceId:`panel${i}`,layoutKey:i===0?'ceph-measurements':'visit',included:i!==2,state:i===3?'unavailable':'available',sourceKeys:[source.key],images:[],comment:''}));
  saved.content.authored.groups[0].sourceKeys.push('ceph3');saved.content.authored.groups[2].sourceKeys=[];saved.content.authored.groups[3].occurrence.sourceNote='PRIVATE_UNAVAILABLE_DATE';rehashSyntheticLongitudinal(saved);
  const plain=studyTextPresentation(saved,saved),illustrated=await illustrateSavedStudy(saved,saved,async()=>{throw Error('no image expected');});
  const appendix=(pages:typeof plain.pages)=>pages.filter(p=>p.title.startsWith('أهلية المقارنة السيفالومترية'));
  expect(appendix(illustrated.pages)).toEqual(appendix(plain.pages));
  for(const presentation of [plain,illustrated])expect(presentation.pages.flatMap(page=>page.sourceKeys)).not.toContain('ceph4');
  for(const value of [plain,illustrated]){
   const text=value.pages.flatMap(p=>p.lines).join('');expect(text).toContain(payload.completion.witnessSha256);expect(text).toContain('T1 → T2');
   for(const forbidden of ['EXT_INDEX','99999994','synthetic_reference_3','synthetic_reference_4','PRIVATE_UNAVAILABLE_DATE','T1 → T4','مصادر سيفالومترية متعددة'])expect(text).not.toContain(forbidden);
  }
  for(const bytes of [await renderStudyTextPptx(plain),await renderIllustratedStudyPptx(illustrated)]){
   const zip=await JSZip.loadAsync(bytes),xml=(await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).map(k=>zip.file(k)!.async('text')))).join('');
   const notes=(await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k)).map(k=>zip.file(k)!.async('text')))).join('');
   expect(notes).not.toContain('ceph3');expect(notes).not.toContain('ceph4');
   expect(xml).toContain('<a:t>');expect(xml).toContain(payload.completion.witnessSha256);expect(xml).toContain('synthetic-saved-engine');expect(xml).not.toContain('EXT_INDEX');
  }
 });
});
