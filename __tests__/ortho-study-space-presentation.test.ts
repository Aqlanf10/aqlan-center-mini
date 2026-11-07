import {describe,expect,it,vi} from 'vitest';
import JSZip from 'jszip';
import {spaceStudyFixture,spaceStudyScope as scope} from './fixtures/ortho-study-space';
import {projectStudySpaceFacts} from '../lib/ortho-study-space-facts';
import {projectStudyRecordedFacts} from '../lib/ortho-case-study-recorded-facts';
import {studyTextPresentation} from '../lib/ortho-study-text-export';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderStudyTextPptx} from '../lib/ortho-study-pptx';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
import {readStudyPanelReview} from '../lib/ortho-case-study-review-contract';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import {studySourceName} from '../lib/ortho-case-presentation-i18n';
import type {CaseTable} from '../lib/ortho-case-render-contract';
const flatten=(blocks:ReturnType<typeof projectStudySpaceFacts>)=>blocks.map(b=>b.kind==='paragraph'?b.text:b.headers.join(' ')+b.rows.map(r=>r.cells.join(' ')).join(' ')).join('\n');
const tables=(blocks:ReturnType<typeof projectStudySpaceFacts>)=>blocks.filter((b):b is CaseTable=>b.kind==='table');

describe('captured space/IPR study presentation',()=>{
 it('labels the source as a documentary snapshot rather than a new measurement',()=>{
  expect(studySourceName('space_ledger','en')).toBe('Documentary space/IPR ledger snapshot');
  expect(studySourceName('space_ledger','ar')).toContain('لقطة وثائقية');
 });
 it('has exactly one prefix-wide totals table, excludes corrected originals, and distinguishes null from zero',()=>{
  const f=spaceStudyFixture(),before=JSON.stringify(f);
  const result=projectStudyRecordedFacts(f.content,scope,'space_panel','draft');expect(result.complete).toBe(true);
  const totals=tables(result.blocks).filter(t=>t.headers.includes('مجموع IPR المنفذ الموثق في اللقطة'));
  expect(totals).toHaveLength(1);expect(totals[0].rows.map(r=>r.cells)).toEqual([['العلوي','11-12','0.2 mm'],['العلوي','21-22','غير معلوم']]);
  const events=tables(result.blocks).find(t=>t.headers[0]==='قيد IPR')!;
  expect(events.rows.find(r=>r.cells[0]==='102')?.cells[1]).toBe('استُبدل بتصحيح؛ غير محتسب');
  expect(events.rows.find(r=>r.cells[0]==='104')?.cells[3]).toBe('0 mm');
  expect(events.rows.find(r=>r.cells[0]==='105')?.cells[3]).toBe('غير معلوم');
  expect(JSON.stringify(f)).toBe(before);
 });
 it('keeps a documented zero contact total distinct from an unknown contact total',()=>{
  const f=spaceStudyFixture(),latest=f.capture.history[0];
  if(latest.content.authored.kind!=='ipr')throw Error('fixture');latest.content.authored.performedUm=0;latest.contentHash=journeyContentHash(latest.content);
  const selection={...f.selection,contentHash:journeyContentHash(f.capture)};
  const totals=tables(projectStudySpaceFacts(f.capture,selection,scope,'draft')).find(t=>t.headers.includes('مجموع IPR المنفذ الموثق في اللقطة'))!;
  expect(totals.rows.map(r=>r.cells[2])).toEqual(['0 mm','غير معلوم']);
 });
 it('preserves original plan and immutable session witness across later plans and corrections',()=>{
  const f=spaceStudyFixture(),blocks=projectStudySpaceFacts(f.capture,f.selection,scope,'documented');
  const events=tables(blocks).find(t=>t.headers[0]==='قيد IPR')!;
  expect(events.rows.find(r=>r.cells[0]==='104')?.cells.slice(4,10)).toEqual(['101','7','17','2024-02-29','SYNTHETIC_ORIGINAL_SESSION_ACTOR','102']);
  expect(events.rows.find(r=>r.cells[0]==='106')?.cells[4]).toBe('103');
  const text=flatten(blocks);expect(text).toContain('SYNTHETIC_ORIGINAL_PLAN');expect(text).toContain('SYNTHETIC_LATER_PLAN');expect(text).not.toContain('تغير مصدر القياسات');
  expect(text).toContain('ليست قياسات Bolton جديدة');expect(text).toContain('لا يحدد مقداراً متبقياً آمناً');
  for(const b of blocks)if(b.kind==='paragraph'){expect(b.sourceKeys).toEqual([f.selection.key]);expect(b.review).toBe('documented');}else for(const r of b.rows){expect(r.sourceKeys).toEqual([f.selection.key]);expect(r.review).toBe('documented');}
 });
 it('uses the existing panel contract and leaves unsupported layouts explicitly unmapped',()=>{
  const f=spaceStudyFixture(),result=projectStudyRecordedFacts(f.content,scope,'space_panel','draft');
  const expected={...scope,revisionId:200,revisionHash:f.revision.contentHash,kind:'draft' as const,panelId:'space_panel',layoutKey:'model-measurements',sourceKeys:[f.selection.key],panelState:'available' as const,included:true,comments:[]};
  const {sourceKeys:_sourceKeys,...envelope}=expected;
  expect(readStudyPanelReview({ok:true,...envelope,title:'Synthetic title',capturedAt:f.content.capturedAt,blocks:result.blocks,unavailable:[],unmapped:[],pendingMediaCount:0},expected).blocks).toEqual(result.blocks);
  f.content.authored.panels[0].layoutKey='mechanotherapy';const unmapped=projectStudyRecordedFacts(f.content,scope,'space_panel','draft');expect(unmapped.blocks).toEqual([]);expect(unmapped.unmapped).toHaveLength(1);
 });
 it('does not expose unavailable or restricted panel captures as ordinary clinical facts',()=>{
  const f=spaceStudyFixture();f.content.authored.panels[0].state='restricted';expect(projectStudyRecordedFacts(f.content,scope,'space_panel','draft').blocks).toEqual([]);
  f.content.authored.panels[0].state='available';f.content.sources[0]={...f.content.sources[0],state:'unavailable',unavailableReason:'source_missing_or_outside_case',payload:null};
  const result=projectStudyRecordedFacts(f.content,scope,'space_panel','draft');expect(result.blocks).toEqual([]);expect(result.unavailable).toHaveLength(1);
 });
 it('rejects tampered content and foreign clinical bindings rather than projecting substitutions',()=>{
  const f=spaceStudyFixture();expect(()=>projectStudySpaceFacts(f.capture,f.selection,{...scope,clinicalCaseId:99},'draft')).toThrow();
  f.capture.history[0].content.adjustment!.recordedBy='CURRENT_SUBSTITUTION';expect(()=>projectStudySpaceFacts(f.capture,f.selection,scope,'draft')).toThrow();
 });
 it('shares saved facts with text and illustrated consumers, without requesting any image',async()=>{
  const f=spaceStudyFixture(),before=JSON.stringify(f.revision),render=vi.fn();
  const text=studyTextPresentation(f.revision,scope),illustrated=await illustrateSavedStudy(f.revision,scope,render);
  expect(illustrated.pages).toEqual(text.pages);expect(render).not.toHaveBeenCalled();expect(JSON.stringify(f.revision)).toBe(before);
  expect(text.pages.flatMap(p=>p.lines).join('')).toContain('SYNTHETIC_ORIGINAL_SESSION_ACTOR');
  expect(text.pages.every(p=>p.sourceKeys.length===1&&p.sourceKeys[0]===f.selection.key)).toBe(true);
 });
 it('excludes all snapshot facts and stage source hashes when its panel is excluded',async()=>{
  const f=spaceStudyFixture();f.content.authored.panels[0].included=false;f.content.authored.panels.push({instanceId:'other',layoutKey:'interview',included:true,state:'not_recorded',sourceKeys:[],images:[],comment:'VISIBLE_SAFE_COMMENT'});
  f.content.authored.groups=[{id:'stage1',label:'Excluded snapshot',phase:'T1',occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:'PRIVATE_SOURCE_NOTE'},sourceKeys:[f.selection.key]}];
  const out=await illustrateSavedStudy(f.revision,scope,vi.fn()),serialized=JSON.stringify(out.pages);
  expect(serialized).toContain('VISIBLE_SAFE_COMMENT');for(const hidden of ['SYNTHETIC_ORIGINAL_PLAN','PRIVATE_SOURCE_NOTE',f.selection.contentHash,f.selection.key])expect(serialized).not.toContain(hidden);
 });
 it('exports both PPTX paths as editable text containing the original witness and captured revision provenance',async()=>{
  const f=spaceStudyFixture(),text=studyTextPresentation(f.revision,scope),illustrated=await illustrateSavedStudy(f.revision,scope,vi.fn());
  for(const bytes of [await renderStudyTextPptx(text),await renderIllustratedStudyPptx(illustrated)]){
   const zip=await JSZip.loadAsync(bytes),files=Object.keys(zip.files);
   const slides=(await Promise.all(files.filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).map(n=>zip.file(n)!.async('text')))).join('');
   for(const token of ['-1.25 mm','0 mm','0.2 mm','11-12','21-22'])expect(slides).toContain(`\u2066${token}\u2069`);
   expect(slides).toContain('SYNTHETIC_ORIGINAL_SESSION_ACTOR');expect(slides).toContain('<a:t>');expect(slides).toContain('rtl="1"');expect(files.filter(n=>/^ppt\/media\/[^/]+$/.test(n))).toEqual([]);
   expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('text')).toContain(f.revision.contentHash);
  }
 });
 it('refuses a valid but oversized full prefix instead of silently truncating its facts',()=>{
  const f=spaceStudyFixture(),template=f.capture.history.find(r=>r.content.authored.kind==='plan')!;
  f.capture.history=Array.from({length:365},(_,i)=>({...structuredClone(template),id:i+1,version:i+1,predecessorId:i===0?null:i})).reverse();
  f.capture.headId=365;f.capture.headVersion=365;const selection={...f.selection,id:365,version:365,contentHash:journeyContentHash(f.capture)};
  expect(()=>projectStudySpaceFacts(f.capture,selection,scope,'draft')).toThrow('study_space_display_limit');expect(f.capture.history).toHaveLength(365);
 });
});
