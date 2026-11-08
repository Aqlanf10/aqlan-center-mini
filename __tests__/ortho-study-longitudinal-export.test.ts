import {describe,it,expect,vi} from 'vitest';
import JSZip from 'jszip';
import {syntheticLongitudinalStudy,rehashSyntheticLongitudinal} from './fixtures/ortho-study-longitudinal';
import {studyTextPresentation} from '../lib/ortho-study-text-export';
import {illustrateSavedStudy} from '../lib/ortho-study-illustrated';
import {renderStudyTextPptx} from '../lib/ortho-study-pptx';
import {renderIllustratedStudyPptx} from '../lib/ortho-study-illustrated-pptx';
const title='أهلية المقارنة السيفالومترية';
const text=(pages:{lines:string[]}[])=>pages.flatMap(page=>page.lines).join('');
function selected(){
 const saved=syntheticLongitudinalStudy();
 saved.content.authored.panels=saved.content.authored.sources.map((source,i)=>({instanceId:`ceph_${i}`,layoutKey:'visit',included:i<2,state:'available',sourceKeys:[source.key],images:[],comment:''}));
 saved.content.authored.groups[2].occurrence.sourceNote='EXCLUDED_PRIVATE_DATE';
 return rehashSyntheticLongitudinal(saved);
}
describe('saved longitudinal eligibility export',()=>{
 it('prints withheld comparisons and captured provenance only for included available panels without numeric interpretation',()=>{
  const saved=selected(),before=JSON.stringify(saved),result=studyTextPresentation(saved,saved);
  const appendix=result.pages.filter(page=>page.title.startsWith(title)),content=text(appendix);
  expect(appendix.length).toBeGreaterThan(0);expect(content).toContain('T1 → T2');
  expect(content).toContain('الفروق العددية محجوبة');expect(content).toContain('synthetic_reference_1');
  expect(content).toContain(saved.content.authored.sources[0].contentHash);expect(content).toContain('1'.repeat(64));
  expect(content).not.toContain('synthetic_reference_3');expect(content).not.toContain('99999994');expect(content).not.toContain('EXT_INDEX');
  expect(text(result.pages)).not.toContain('EXCLUDED_PRIVATE_DATE');expect(JSON.stringify(saved)).toBe(before);
 });
 it('derives ambiguity and pairs after filtering mixed-stage excluded sources',()=>{
  const saved=selected();saved.content.authored.panels.forEach((panel,index)=>{panel.included=index===0||index===2;});
  saved.content.authored.groups[0].sourceKeys=['ceph1','ceph2'];saved.content.authored.groups[1].sourceKeys=[];
  rehashSyntheticLongitudinal(saved);
  const pages=studyTextPresentation(saved,saved).pages.filter(page=>page.title.startsWith(title)),content=text(pages);
  expect(content).toContain('T1 → T3');expect(content).not.toContain('T1 → T2');expect(content).not.toContain('T3 → T4');
  expect(content).not.toContain('مصادر سيفالومترية متعددة');expect(content).not.toContain('synthetic_reference_2');
  expect(content).not.toContain(saved.content.authored.sources[1].contentHash);
  expect(pages.flatMap(page=>page.sourceKeys)).not.toContain('ceph2');
 });
 it('does not append eligibility to per-panel rendering, excluded panels, or unavailable panels',()=>{
  const saved=selected();
  expect(studyTextPresentation(saved,saved,true,'ceph_0').pages.some(page=>page.title.startsWith(title))).toBe(false);
  saved.content.authored.panels.forEach(panel=>{panel.state='unavailable';});rehashSyntheticLongitudinal(saved);
  expect(studyTextPresentation(saved,saved).pages.some(page=>page.title.startsWith(title))).toBe(false);
 });
 it('includes the eligibility appendix once in illustrated output and preserves the notice in native editable PPTX',async()=>{
  const saved=selected(),plain=studyTextPresentation(saved,saved),render=vi.fn();
  const illustrated=await illustrateSavedStudy(saved,saved,render);
  expect(render).not.toHaveBeenCalled();
  expect(illustrated.pages.filter(page=>page.title.startsWith(title))).toEqual(plain.pages.filter(page=>page.title.startsWith(title)));
  for(const bytes of [await renderStudyTextPptx(plain),await renderIllustratedStudyPptx(illustrated)]){
   const zip=await JSZip.loadAsync(bytes),slides=(await Promise.all(Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).map(k=>zip.file(k)!.async('text')))).join('');
   expect(slides).toContain('الفروق العددية محجوبة');expect(slides).toContain(saved.content.authored.sources[0].contentHash);
   expect(slides).not.toContain('synthetic_reference_3');expect(slides).not.toContain('EXCLUDED_PRIVATE_DATE');expect(slides).toContain('<a:t>');
  }
 });
});
