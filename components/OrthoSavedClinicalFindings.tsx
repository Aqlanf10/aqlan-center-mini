import type { AssessmentReadResponseV2 } from '@/lib/ortho-assessment-response-v2';
import type { AssessmentObservationV2 } from '@/lib/ortho-assessment-v2';
import { CLINICAL_FIELDS_V2, blankClinicalObservationV2 } from '@/lib/ortho-assessment-clinical-fields';
type Ready = Extract<AssessmentReadResponseV2,{state:'ready'}>;
type Props={revision:NonNullable<Ready['revision']>;section?:'interview'|'extraoral'|'intraoral';sourceStates:Ready['sourceStates']};
const states={not_recorded:'غير مسجل',measured:'مقاس',recorded:'موثق',unknown:'غير معلوم',not_measured:'لم يُقَس / لم يُقيّم',unavailable:'غير متاح',not_applicable:'لا ينطبق',tooth_absent:'السن مفقود',not_erupted:'لم يبزغ'};
const groups={history:'المقابلة وتاريخ الحالة',facial:'الفحص خارج الفم',intraoral:'الفحص داخل الفم'};
const groupFor={interview:'history',extraoral:'facial',intraoral:'intraoral'} as const;
function target(row:AssessmentObservationV2){const t=row.target;return t.kind==='case'?'الحالة':t.kind==='arch'?`الفك: ${t.arch==='upper'?'العلوي':'السفلي'}`:t.kind==='side'?`الجهة: ${t.side==='right'?'اليمنى':'اليسرى'}`:t.kind==='tooth'?`السن: ${t.tooth}`:<>{t.kind==='contact'?'التماس':'المقطع'}: <bdi dir="ltr">{t.teeth.join('-')}</bdi></>;}
function Observation({row,sourceStates}: {row:AssessmentObservationV2;sourceStates:Ready['sourceStates']}){
 const p=row.provenance;
 return <article className="min-w-0 space-y-1 border-t py-2" aria-label={`الملاحظة المحفوظة ${row.id}`}>
 <h6 className="whitespace-pre-wrap break-words font-bold">التسمية المحفوظة: {row.label}</h6>
 <p>معرف الملاحظة: {row.id} · التعريف {row.definition} · نسخة التعريف {row.definitionVersion} · النطاق {target(row)}</p>
 <p>حالة القيمة: {states[row.value.state]}</p>
 {row.value.state==='measured'?<p>القيمة المحفوظة: <bdi dir="ltr">{`${row.value.value} ${row.unit}`}</bdi></p>:row.value.state==='recorded'?<p className="whitespace-pre-wrap break-words">النص المحفوظ: {row.value.text}</p>:'reason'in row.value?<p className="whitespace-pre-wrap break-words">السبب المحفوظ: {row.value.reason}</p>:null}
 <p>الوحدة المسجلة: {row.unit==='qualitative'?'وصف نوعي (qualitative)':row.unit}</p>
 <p>تاريخ الملاحظة أو القياس: {row.occurredOn===null?'غير مسجل':row.occurredOn.state==='known'?<bdi dir="ltr">{row.occurredOn.date}</bdi>:<>غير معلوم · <span className="whitespace-pre-wrap">{row.occurredOn.reason}</span></>}</p>
 {p?<><p className="whitespace-pre-wrap break-words">المنفذ الموثق: {p.performer.state==='documented'?p.performer.attribution:'غير معلوم'}؛ لا يُفترض أنه مسجّل المراجعة.</p>
 <p className="whitespace-pre-wrap break-words">طريقة التوثيق: {p.method.kind} · النسخة {p.method.version} · {p.method.description}</p>
 {p.sources.map(source=>{const current=sourceStates.find(s=>s.source.kind===source.kind&&s.source.id===source.id&&s.source.version===source.version);return <p className="break-all" key={`${source.kind}:${source.id}:${source.version}`}>مرجع محفوظ: {source.kind} #{source.id} · النسخة {source.version} · حالة المرجع في هذه القراءة: {current?.state==='available'?'متاح':current?.state==='changed'?'تغير المصدر':current?.state==='unavailable'?'غير متاح':'لم تُقدّم حالة لهذا المرجع'}</p>;})}
 {!p.sources.length&&<p>لا مراجع مصادر مرتبطة بهذا المدخل.</p>}
 {p.copiedFrom&&<p className="break-all">منقول من مراجعة #{p.copiedFrom.revisionId} · بصمة المصدر {p.copiedFrom.contentHash} · {p.copiedFrom.kind==='observation_v2'?`معرف الملاحظة ${p.copiedFrom.observationId}`:`مسار الحقل التاريخي ${p.copiedFrom.fieldPath}`}</p>}
 </>:<p>بيانات المصدر والمنفذ غير مسجلة لهذا المدخل.</p>}
 </article>;
}
const sourceLabels={document:'مستند',ceph_study:'دراسة سيفالو',patient_history:'تاريخ طبي',clinical_visit:'زيارة',assessment_revision:'مراجعة تقييم'};
/** Source concerns stay visible even while exact observations are collapsed. */
function SourceWarnings({rows,sourceStates,additional=false}:{rows:AssessmentObservationV2[];sourceStates:Ready['sourceStates'];additional?:boolean}){
 const warnings=rows.flatMap(row=>{
  const provenance=row.provenance;
  if(!provenance)return row.value.state==='not_recorded'?[]:[{key:row.id,text:`${row.label}: بيانات المصدر والمنفذ غير مسجلة لهذا المدخل.`}];
  return provenance.sources.flatMap(source=>{
   const current=sourceStates.find(s=>s.source.kind===source.kind&&s.source.id===source.id&&s.source.version===source.version);
   if(current?.state==='available')return [];
   return [{key:`${row.id}:${source.kind}:${source.id}:${source.version}`,text:`${row.label} · ${sourceLabels[source.kind]} #${source.id}: ${current?.state==='changed'?'تغير المصدر':current?.state==='unavailable'?'غير متاح':'لم تُقدّم حالة لهذا المرجع'}`}];
  });
 });
 return warnings.length?<div role="status" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950">
  <p className="font-bold">{additional?'ملاحظات إضافية: تحتاج مراجعة المصدر':'مصادر تحتاج مراجعة'}</p>
  <ul className="list-inside list-disc">{warnings.map(w=><li className="break-words" key={w.key}>{w.text}</li>)}</ul>
 </div>:null;
}
/** Presenter only: its caller supplies the selected, verified and authorized read.
 * No draft conversion, calculation, current-source substitution or admission claim. */
export default function OrthoSavedClinicalFindings({revision,section,sourceStates}:Props){
 if(revision.schemaVersion!==2)return <p role="status">العرض المنظم لنتائج الفحص غير متاح لهذه النسخة التاريخية؛ يبقى السجل الخام محفوظًا دون تحويل أو تفسير تلقائي.</p>;
 const observations=revision.content.draft.observations.observations;
 const definitions=CLINICAL_FIELDS_V2.map(([field,label,group])=>{const shape=blankClinicalObservationV2(field),row=observations.find(o=>o.id===shape.id);const matched=!!row&&row.definition===shape.definition&&row.definitionVersion===shape.definitionVersion&&row.unit===shape.unit&&row.target.kind===shape.target.kind&&(shape.target.kind==='case'||shape.target.kind==='arch'&&row.target.kind==='arch'&&row.target.arch===shape.target.arch||shape.target.kind==='side'&&row.target.kind==='side'&&row.target.side===shape.target.side);return {field,label,group,row,matched};});
 const additional=observations.filter(row=>!definitions.some(d=>d.matched&&d.row===row));
 const complaint=definitions.find(d=>d.field==='chiefComplaint'&&d.matched)?.row;
 return <section aria-label="نتائج المقابلة والفحص المحفوظة" className="min-w-0 space-y-3 rounded-lg border p-3" dir="rtl">
 <h4 className="font-bold">نتائج المقابلة والفحص المحفوظة</h4>
 <p className="text-xs">المراجعة #{revision.id} · النسخة {revision.version} · تسجيل {revision.createdAt.slice(0,10)}</p>
 <p className="text-xs">ملخص توثيق النسخة المختارة، وليس اعتمادًا سريريًا. غير المسجل أو غير المعلوم لا يعني نتيجة طبيعية.</p>
 {(!section||section==='interview')&&complaint?.value.state==='recorded'&&<p className="whitespace-pre-wrap break-words text-sm"><strong>الشكوى الرئيسية المحفوظة: </strong>{complaint.value.text}</p>}
 {(['history','facial','intraoral'] as const).filter(group=>!section||group===groupFor[section]).map(group=>{
  const fields=definitions.filter(d=>d.group===group),matched=fields.filter(d=>d.matched).map(d=>d.row!);
  const absent=fields.filter(d=>!d.row).length,conflicts=fields.filter(d=>d.row&&!d.matched);
  return <section key={group} aria-label={`ملخص التوثيق المحفوظ — ${groups[group]}`} className="space-y-2 rounded-lg border p-2">
   <h5 className="font-bold">{groups[group]}</h5>
   <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
    {(Object.keys(states) as Array<keyof typeof states>).map(state=>{const count=matched.filter(row=>row.value.state===state).length;return count?<li key={state}>{states[state]}: {count}</li>:null;})}
    {!!absent&&<li>لا يوجد مدخل: {absent}</li>}{!!conflicts.length&&<li>هوية مختلفة: {conflicts.length}</li>}
   </ul>
   {conflicts.map(d=><p key={d.field} role="alert" className="text-sm text-amber-950">{d.label}: هوية المدخل تحتاج مراجعة؛ لم يُنسب تلقائيًا إلى هذا الحقل.</p>)}
   <SourceWarnings rows={matched} sourceStates={sourceStates}/>
   <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">تفاصيل {groups[group]} ({fields.length})</summary>
    {fields.map(d=><div key={d.field} className="py-2"><p>حقل الفهرس: {d.label}</p>{d.matched?<Observation row={d.row!} sourceStates={sourceStates}/>:<p>{d.row?'معرف محفوظ بتعريف أو وحدة أو نطاق مختلف؛ لم يُنسب تلقائيًا إلى هذا الحقل.':'لا يوجد مدخل محفوظ لهذا الحقل؛ يختلف ذلك عن مدخل مسجل بحالة «غير مسجل».'}</p>}</div>)}
   </details>
  </section>;
 })}
 <SourceWarnings rows={additional} sourceStates={sourceStates} additional/>
 <details><summary className="min-h-11 cursor-pointer py-3 text-sm">بيانات المراجعة المحفوظة</summary>
  <p>وقت التسجيل <bdi dir="ltr">{revision.createdAt}</bdi> · المسجّل {revision.createdBy}</p>
  <p className="break-all">بصمة المراجعة: {revision.contentHash} · متحقق الحفظ {revision.content.verifierVersion}</p>
  <p className="whitespace-pre-wrap break-words">سبب المراجعة: {revision.reason}</p>
  <p>هذه نتائج النسخة المختارة فقط، وليست تقييمًا حاليًا أو تشخيصًا مستنتجًا. غياب المدخل لا يعني نتيجة طبيعية أو نفي المشكلة. وقت التسجيل منفصل عن تاريخ الملاحظة. حالة المصدر الحالية لا تثبت صحة الملاحظة التاريخية.</p>
 </details>
 {!!additional.length&&<details><summary className="min-h-11 cursor-pointer py-3">ملاحظات محفوظة إضافية أو ذات هوية مختلفة ({additional.length})</summary><p>لم تُنسب هذه المدخلات إلى أقسام الفحص تلقائيًا؛ تُعرض بهويتها ونطاقها المحفوظين، بما فيها القياسات غير التابعة للفهرس.</p>{additional.map(row=><Observation key={row.id} row={row} sourceStates={sourceStates}/>)}</details>}
 </section>;
}
