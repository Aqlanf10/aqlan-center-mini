import type {AssessmentReadResponseV2} from '@/lib/ortho-assessment-response-v2';
import type {AssessmentObservationV2} from '@/lib/ortho-assessment-v2';
import {buildSavedModelReview} from '@/lib/ortho-assessment-saved-model';
import OrthoSavedModelResult, {SavedQuantity} from './OrthoSavedModelResult';
const states={not_recorded:'غير مسجل',measured:'مقاس',recorded:'موثق',unknown:'غير معلوم',not_measured:'لم يُقَس',unavailable:'غير متاح',not_applicable:'لا ينطبق',tooth_absent:'السن مفقود',not_erupted:'لم يبزغ'};
const methods:Record<string,string>={arch_space:'تحليل مساحة القوس',bolton_anterior:'Bolton أمامي',bolton_overall:'Bolton عام',tanaka_johnston_1974:'Tanaka–Johnston: تقدير المسافة المختلطة'};
function Target({value}:{value:AssessmentObservationV2['target']}){return <>{value.kind==='tooth'?`السن ${value.tooth}`:value.kind==='arch'?`الفك ${value.arch==='upper'?'العلوي':'السفلي'}`:value.kind==='side'?`الجهة ${value.side==='right'?'اليمنى':'اليسرى'}`:value.kind==='case'?'الحالة':<><span>{value.kind==='contact'?'تماس':'مقطع'}</span> <bdi dir="ltr">{value.teeth.join('-')}</bdi></>}</>;}
function Observation({row}:{row:AssessmentObservationV2}) {
 const p=row.provenance;
 return <article className="min-w-0 space-y-1 border-t py-2 text-sm"><h6 className="font-bold">{row.label} · <Target value={row.target}/></h6>
  <p>معرف المدخل: {row.id} · {states[row.value.state]}{row.value.state==='measured'?<> · <SavedQuantity value={row.value.value} unit={row.unit}/></>:row.value.state==='recorded'?` · ${row.value.text}`:'reason' in row.value?` · ${row.value.reason}`:''}</p>
  <p>تاريخ الملاحظة أو القياس: {row.occurredOn===null?'غير مسجل':row.occurredOn.state==='known'?<bdi dir="ltr">{row.occurredOn.date}</bdi>:`غير معلوم · ${row.occurredOn.reason}`}</p>
  {p?<><p>المنفذ الموثق: {p.performer.state==='documented'?p.performer.attribution:'غير معلوم'}؛ لا يُفترض أنه مسجل المراجعة.</p><p className="whitespace-pre-wrap break-words">الطريقة: {p.method.kind} · النسخة {p.method.version} · {p.method.description}</p>
  {p.sources.map(source=><p key={`${source.kind}:${source.id}:${source.version}`} className="break-all">مرجع تاريخي: {source.kind} #{source.id} · النسخة {source.version}</p>)}
  {p.copiedFrom&&<p className="break-all">منقول من مراجعة #{p.copiedFrom.revisionId} · البصمة {p.copiedFrom.contentHash} · {'observationId' in p.copiedFrom?p.copiedFrom.observationId:p.copiedFrom.fieldPath}</p>}</>:<p>لا مصدر أو منفذ موثق لهذا المدخل.</p>}
 </article>;
}
/** Display exact saved results; never opens an editor or recalculates measurements. */
export default function OrthoSavedModelReview({data,expected}:{data:AssessmentReadResponseV2;expected:Parameters<typeof buildSavedModelReview>[1]}) {
 const result=buildSavedModelReview(data,expected);
 if(!result.ok)return <p role="status">{result.code==='saved_model_unavailable'?'العرض المنظم للقياسات غير متاح لهذه النسخة؛ يبقى السجل الخام المحفوظ أدناه.':'تعذر مطابقة النتائج والمدخلات المحفوظة؛ لم تُحسب نتائج بديلة.'}</p>;
 return <section aria-label="مراجعة قياسات وتحليلات النماذج المحفوظة" className="min-w-0 space-y-3 rounded-lg border p-3">
  <h4 className="font-bold">مراجعة قياسات وتحليلات النماذج المحفوظة</h4>
  <p>المراجعة #{result.revision.id} · النسخة {result.revision.version} · وقت التسجيل <bdi dir="ltr">{result.revision.createdAt}</bdi> · المسجل {result.revision.createdBy}</p>
  <p className="break-all text-xs">بصمة النسخة: {result.revision.contentHash} · متحقق الحفظ: {result.verifierVersion}</p>
  <p>نتائج النسخة المختارة ومدخلاتها فقط؛ لا تدخل المسودة أو القياسات الحالية، ولا يُعاد الحساب أو تحديث المرجع. عرض النتيجة لا يثبت اعتماداً سريرياً.</p>
  <p className="whitespace-pre-wrap break-words">سبب المراجعة: {result.revision.reason}</p>
  {result.analyses.length===0&&<p>لم تُحفظ تحليلات مختارة في هذه النسخة؛ لم يُحسب تحليل جديد للعرض.</p>}
  {result.analyses.map(({selection,stored})=><article key={selection.id} className="min-w-0 space-y-2 rounded-lg border p-3">
   <h5 className="font-bold">{methods[selection.method]??selection.method}{'arch' in selection?` · الفك ${selection.arch==='upper'?'العلوي':'السفلي'}`:''}</h5>
   <p>معرف التحليل {selection.id} · مجموعة القياسات {selection.measurementSetId}</p>
   <OrthoSavedModelResult result={stored.result}/>
   <p className="break-all text-xs">بصمة النتيجة المحفوظة: {stored.resultHash}</p>
   <p className="break-words text-xs">معرفات المدخلات التي اعتمدت عليها النتيجة المحفوظة: {stored.result.dependencyObservationIds.length?stored.result.dependencyObservationIds.join('، '):'لا توجد مراجع مدخلات محفوظة'}</p>
  </article>)}
  <details><summary className="min-h-11 cursor-pointer py-3 font-bold">القياسات ومصادرها كما حُفظت</summary>
   {result.cast.measurementSets.map(set=><div key={set.id} className="break-words py-2 text-sm"><p>مجموعة #{set.id} · عضوية عروض الأسنان بالترتيب المحفوظ: {set.toothWidthObservationIds.join('، ')||'لا توجد'}</p><p>مرجع المساحة المتاحة العلوية: {set.upperAvailableObservationId??'غير مسجل'} · السفلية: {set.lowerAvailableObservationId??'غير مسجل'}</p></div>)}
   {result.cast.observations.map(row=><Observation key={row.id} row={row}/>)}
   {result.cast.observations.length===0&&<p>لا توجد مدخلات قياس مرتبطة بالمجموعات المحفوظة.</p>}
  </details>
  <details><summary className="min-h-11 cursor-pointer py-3">حالة مراجع المصادر في هذه القراءة</summary><p>هذه الحالات منفصلة عن الشاهد التاريخي؛ لا تُستبدل القيم أو الصور القديمة بمصدر حالي، والإتاحة ليست اعتماداً سريرياً.</p>
   {result.sourceStates.map(({source,state})=><p key={`${source.kind}:${source.id}:${source.version}`} className="break-all">{source.kind} #{source.id} · النسخة {source.version}: {state==='available'?'متاح في هذه القراءة':state==='changed'?'تغير المصدر؛ الشاهد التاريخي لم يُستبدل':'غير متاح في هذه القراءة؛ لا يُستنتج أنه لم يوجد'}</p>)}
   {result.sourceStates.length===0&&<p>لا مراجع مصادر مرتبطة محفوظة.</p>}
  </details>
 </section>;
}
