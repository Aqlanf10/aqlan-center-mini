import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import OrthoSavedClinicalFindings from '../components/OrthoSavedClinicalFindings';
import {blankClinicalObservationV2,CLINICAL_FIELDS_V2} from '../lib/ortho-assessment-clinical-fields';
import type {AssessmentRevisionV2} from '../lib/ortho-assessment-persisted-v2';
import type {AssessmentObservationV2} from '../lib/ortho-assessment-v2';
type Props=React.ComponentProps<typeof OrthoSavedClinicalFindings>;
function revision(rows:AssessmentObservationV2[]=[]):AssessmentRevisionV2{return {id:4,patientId:1,recordedPatientId:9,orthoCaseId:2,clinicalCaseId:3,version:1,supersedesRevisionId:null,createdAt:'2026-01-01T00:00:00.000Z',createdBy:'Synthetic recorder',reason:'Synthetic reason',recordingContext:'retrospective',contentHash:'a'.repeat(64),schemaVersion:2,content:{schemaVersion:2,verifierVersion:'ortho-assessment-payload-2.2.1',draft:{schemaVersion:2,observations:{schemaVersion:2,dentitionObservationId:null,observations:rows},measurementSets:[],analyses:[]},results:[]}};}
const html=(rows:AssessmentObservationV2[]=[],props:Partial<Props>={})=>renderToStaticMarkup(<OrthoSavedClinicalFindings revision={revision(rows)} sourceStates={[]} {...props}/>);
const populated=()=>({...blankClinicalObservationV2('chiefComplaint'),label:'Exact authored <label>',value:{state:'recorded' as const,text:'  Saved\nnegative finding <script>  '},occurredOn:{state:'unknown' as const,reason:'No recorded date'},provenance:{performer:{state:'unknown' as const},method:{version:1 as const,kind:'external_report' as const,description:'Exact method'},sources:[],copiedFrom:null}});
describe('saved clinical findings presentation',()=>{
 it('preserves authored strings and provenance without controls or mutation',()=>{const row=populated(),before=structuredClone(row),value=html([row]);for(const exact of ['Exact authored &lt;label&gt;','  Saved\nnegative finding &lt;script&gt;  ','No recorded date','Exact method','Synthetic recorder'])expect(value).toContain(exact);expect(value).not.toMatch(/<input|<select|<button|<a |<script>|<textarea/);expect(row).toEqual(before);});
 it('distinguishes an absent named row from an explicit not-recorded row',()=>{expect(html()).toContain('لا يوجد مدخل محفوظ لهذا الحقل');const value=html([blankClinicalObservationV2('chiefComplaint')],{section:'interview'});expect(value).toContain('حالة القيمة: غير مسجل');expect(value).toContain('تاريخ الملاحظة أو القياس: غير مسجل');});
 it.each(['unknown','not_measured','unavailable','not_applicable','tooth_absent','not_erupted'] as const)('retains %s reason without substituting zero or normality',state=>{const row={...populated(),value:{state,reason:'Exact refusal reason'}};const value=html([row]);expect(value).toContain('Exact refusal reason');expect(value).not.toContain('0 mm');});
 it.each([-2.375,0,3.125])('shows exact signed mm value %s',value=>{const row={...blankClinicalObservationV2('overjet'),value:{state:'measured' as const,value},occurredOn:{state:'known' as const,date:'2025-02-03'}};expect(html([row],{section:'intraoral'})).toContain(`<bdi dir="ltr">${value} mm</bdi>`);expect(html([row])).toContain('2025-02-03');});
 it.each([['interview','history'],['extraoral','facial'],['intraoral','intraoral']] as const)('filters canonical findings to %s', (section,group)=>{const rows=CLINICAL_FIELDS_V2.map(([field])=>blankClinicalObservationV2(field));const value=html(rows,{section});for(const [field,,g]of CLINICAL_FIELDS_V2)expect(value.includes(`الملاحظة المحفوظة clinical_${field}`)).toBe(g===group);});
 it.each(['target','unit','definition'] as const)('does not relabel conflicting named %s and preserves extra observation',key=>{const row=blankClinicalObservationV2('upperMidline');if(key==='target')row.target={kind:'case'};if(key==='unit')row.unit='mm';if(key==='definition')row.definition='overjet';row.label='Conflicting authored label';const custom={...populated(),id:'custom_tooth',target:{kind:'tooth' as const,tooth:11}};const value=html([row,custom]);expect(value).toContain('معرف محفوظ بتعريف أو وحدة أو نطاق مختلف');expect(value).toContain('Conflicting authored label');expect(value).toContain('custom_tooth');expect(value).toContain('السن: 11');});
 it.each(['observation_v2','legacy_field_v1'] as const)('preserves %s copy lineage and changed source without fetching',kind=>{const row:AssessmentObservationV2=populated(),source={kind:'document' as const,id:12,version:'historical-source'};row.provenance={...row.provenance!,sources:[source],performer:{state:'documented',attribution:'Original performer'},copiedFrom:kind==='observation_v2'?{kind,revisionId:8,contentHash:'b'.repeat(64),observationId:'original_observation'}:{kind,revisionId:8,contentHash:'b'.repeat(64),fieldPath:'original.path'}};const value=html([row],{sourceStates:[{source,state:'changed'}]});for(const exact of ['Original performer','historical-source','تغير المصدر','b'.repeat(64),kind==='observation_v2'?'original_observation':'original.path'])expect(value).toContain(exact);expect(value).not.toContain('<a ');});
 it('uses selected historical revision metadata only and refuses legacy interpretation',()=>{const historical=revision([populated()]);historical.id=19;historical.version=3;expect(html([],{revision:historical})).toContain('المراجعة #19');expect(html([],{revision:{...historical,schemaVersion:1} as unknown as Props['revision']})).toContain('دون تحويل أو تفسير تلقائي');});
});

// Semantic collapsed-tree projection, not browser layout proof.
function visibleText(node:React.ReactNode):string {
 if(typeof node==='string'||typeof node==='number')return String(node);
 if(Array.isArray(node))return node.map(visibleText).join('');
 if(!React.isValidElement(node))return '';
 const element=node as React.ReactElement<{children?:React.ReactNode;open?:boolean}>;
 if(typeof element.type==='function')return visibleText((element.type as (props:unknown)=>React.ReactNode)(element.props));
 if(element.type==='details'&&!element.props.open){const summary=React.Children.toArray(element.props.children).find(child=>React.isValidElement(child)&&child.type==='summary');return visibleText(summary);}
 return visibleText(element.props.children);
}
const visible=(rows:AssessmentObservationV2[],props:Partial<Props>={})=>visibleText(<OrthoSavedClinicalFindings revision={revision(rows)} sourceStates={[]} {...props}/>);

describe('compact saved documentation overview',()=>{
 it('shows the exact saved complaint in the interview overview without treating unknown or conflicting values as a complaint',()=>{
  const row=populated();
  for(const section of [undefined,'interview'] as const){const value=visible([row],{section});expect(value).toContain('الشكوى الرئيسية المحفوظة');expect(value).toContain('  Saved\nnegative finding <script>  ');}
  expect(visible([row],{section:'extraoral'})).not.toContain('Saved');
  expect(visible([{...row,value:{state:'unknown',reason:'Synthetic unknown'}}])).not.toContain('الشكوى الرئيسية المحفوظة');
  expect(visible([{...row,target:{kind:'arch',arch:'upper'}}])).not.toContain('الشكوى الرئيسية المحفوظة');
 });

 it('keeps exact stored details expandable while summarizing only canonical fields',()=>{
  const rows=CLINICAL_FIELDS_V2.map(([field])=>blankClinicalObservationV2(field));rows[0]=populated();
  const value=visible(rows,{section:'interview'});
  expect(value).toContain('موثق: 1');expect(value).toContain('غير مسجل: 4');
  expect(value).not.toContain('معرف الملاحظة:');expect(value).not.toContain('Exact method');
  expect(html(rows,{section:'interview'})).toContain('Exact method');expect(html(rows)).toContain('Saved');
  expect(value).not.toMatch(/جاهز|100%|اكتمال/);
 });
 it('keeps absent, not-recorded and every explicit nonmeasurement state distinct',()=>{
  const rows=CLINICAL_FIELDS_V2.filter(([, ,group])=>group==='intraoral').slice(0,6).map(([field],index)=>({...blankClinicalObservationV2(field),value:index===0?{state:'not_recorded' as const}:{state:(['unknown','not_measured','unavailable','not_applicable','tooth_absent'] as const)[index-1],reason:'Synthetic reason'}}));
  const value=visible(rows,{section:'intraoral'});
  for(const label of ['غير مسجل: 1','غير معلوم: 1','لم يُقَس / لم يُقيّم: 1','غير متاح: 1','لا ينطبق: 1','السن مفقود: 1','لا يوجد مدخل: 8'])expect(value).toContain(label);
  expect(value).not.toContain('0 mm');
 });
 it('keeps scope/definition conflicts visible and never counts them as a recorded finding',()=>{
  const row={...populated(),target:{kind:'arch' as const,arch:'upper' as const}};
  const value=visible([row],{section:'interview'});
  expect(value).toContain('الشكوى الرئيسية');expect(value).toContain('هوية المدخل تحتاج مراجعة');
  expect(value).toContain('هوية مختلفة: 1');expect(value).not.toContain('موثق: 1');
  expect(html([row])).toContain('Exact authored &lt;label&gt;');
 });
 it.each(['changed','unavailable','unreported'] as const)('keeps %s source warnings visible with details collapsed, including additional observations',state=>{
  const source={kind:'document' as const,id:12,version:'exact-stored-version'};const row:AssessmentObservationV2=populated();
  row.provenance={...row.provenance!,sources:[source]};
  const props:Partial<Props>={sourceStates:state==='unreported'?[]:[{source,state}]};
  const value=visible([row,{...row,id:'custom-observation'}],props);
  expect(value).toContain(state==='changed'?'تغير المصدر':state==='unavailable'?'غير متاح':'لم تُقدّم حالة لهذا المرجع');
  expect(value).toContain('مستند #12');expect(value).toContain('ملاحظات إضافية: تحتاج مراجعة المصدر');
  expect(html([row],props)).toContain('exact-stored-version');
 });
});
