import type { DraftAnalysisReadinessV2 } from '@/lib/ortho-assessment-engine-v2';
export function SavedQuantity({value,unit='mm'}:{value:number;unit?:string}) { return <bdi dir="ltr" className="inline-block whitespace-nowrap tabular-nums">{String(value)} {unit}</bdi>; }
const inapplicable={tooth_absent:'السن مفقود؛ لا يُستبدل بصفر',not_erupted:'السن لم يبزغ؛ القياس الفعلي مطلوب لهذه الطريقة',segment_width_already_measured:'قياس محفوظ موجود؛ لم يُستبدل بتنبؤ',target_not_applicable:'الهدف موثق كغير منطبق'};
/** Stored result only. Never calls the current or historical calculation engine. */
export default function OrthoSavedModelResult({result}:{result:DraftAnalysisReadinessV2}) {
  if(result.state==='incomplete') return <div><p>النتيجة المحفوظة: مدخلات غير مكتملة؛ لا يُستنتج صفر أو قياس طبيعي.</p><ul>{result.missing.map((missing,index)=><li key={index}>{missing.kind==='dentition'?'نوع الأسنان غير موثق':missing.kind==='available_space'?`المساحة المتاحة للفك ${missing.arch==='upper'?'العلوي':'السفلي'} غير مكتملة`:missing.kind==='unerupted_segment_status'?`حالة بزوغ السن ${missing.tooth} غير موثقة كغير بازغ`:`قياس السن ${missing.tooth} غير مكتمل`} · مرجع الملاحظة: {missing.observationId??'لا يوجد'}</li>)}</ul></div>;
  if(result.state==='unsupported_dentition') return <p>النتيجة المحفوظة: نوع الأسنان لا تدعمه طريقة التحليل المختارة؛ لا تُعرض نتيجة بديلة.</p>;
  if(result.state==='inapplicable') return <p>النتيجة المحفوظة غير منطبقة: السن {result.tooth} · {inapplicable[result.reason]}.</p>;
  if(result.state==='outside_supported_predictor_domain') return <div><p>النتيجة المحفوظة خارج مجال دعم التنبؤ: مجموع القواطع السفلية <SavedQuantity value={result.predictorSumMm}/>؛ المجال المحفوظ <SavedQuantity value={result.minimumMm}/> إلى <SavedQuantity value={result.maximumMm}/>.</p><p>هذا مجال دعم للنسخة المحفوظة، وليس معياراً تشخيصياً أو مدى طبيعياً للمريض. لم تُحسب نتيجة جديدة.</p><p className="break-all">سياسة النطاق المحفوظة: {result.policyVersion}</p></div>;
  const witness=result.witness, value=witness.result;
  return <div className="space-y-2">
    <p>حالة تحليل محفوظة، غير معتمدة سريرياً؛ حفظها لا يوصي بقلع أو برد أو خطة علاج.</p>
    {value.state==='unavailable'?<p>الحساب المحفوظ غير متاح: {value.reason}</p>:value.method==='arch_space'?<>
      <p>المساحة المتاحة المقاسة: <SavedQuantity value={value.availableMm}/></p><p>المطلوب المحسوب من القياسات: <SavedQuantity value={value.requiredMm}/></p><p>المتاح ناقص المطلوب: <SavedQuantity value={value.availableMinusRequiredMm}/></p><p>إشارة الفرق وصف للحساب المحفوظ، وليست خطة علاج.</p>
    </>:value.method==='tanaka_johnston_1974_approximation_v1'?<>
      <p>مجموع القواطع السفلية المقاس: <SavedQuantity value={value.measuredLowerIncisorSumMm}/></p><p>مجموع قواطع الفك المطلوب المقاس: <SavedQuantity value={value.measuredTargetIncisorSumMm}/></p>
      <p>تقدير الناب والضاحكين معاً لكل جهة: <SavedQuantity value={value.predictedCaninePremolarPerQuadrantMm}/></p><p>تقدير الجهتين: <SavedQuantity value={value.predictedBothQuadrantsMm}/></p>
      <p>المساحة المتاحة المقاسة: <SavedQuantity value={value.measuredAvailableMm}/></p><p>المطلوب المقدّر: <SavedQuantity value={value.estimatedRequiredMm}/></p><p>المتاح ناقص المطلوب المقدّر: <SavedQuantity value={value.availableMinusEstimatedRequiredMm}/></p>
      <p>التنبؤ للمقطع المجمع، وليس عرض كل سن منفرداً. دعم الطريقة ومجتمع مرجعها محدودان؛ ملاءمتها لهذا المريض غير معتمدة، والنتيجة ليست تشخيصاً.</p>
    </>:<>
      <p>مجموع العلوي المقاس: <SavedQuantity value={value.upperMm}/> · مجموع السفلي المقاس: <SavedQuantity value={value.lowerMm}/></p><p>النسبة المحسوبة: <SavedQuantity value={value.ratioPercent} unit="%"/></p>
      <p>فرق السفلي مع تثبيت العلوي كمرجع: <SavedQuantity value={value.upperReference.lowerMinusExpectedMm}/></p><p>فرق العلوي مع تثبيت السفلي كمرجع: <SavedQuantity value={value.lowerReference.upperMinusExpectedMm}/></p>
      <p>نسبة Bolton المرجعية ليست معياراً شخصياً للطبيعية. الفرقان بديلان لكل فك مع تثبيت الآخر؛ لا يُجمعان ولا يحددان وصفة برد بين الأسنان.</p>
    </>}
    <details><summary className="min-h-11 cursor-pointer py-3">الشاهد وإصدار الحساب المحفوظ</summary><p className="break-all">المحرك: {witness.formula.engineVersion} · المعادلة: {witness.formula.formulaVersion}</p>
      {witness.reference?<><p className="whitespace-pre-wrap break-words">المصدر المحفوظ: {witness.reference.source}</p><p>معرف المرجع: {witness.reference.id} · النسخة: {witness.reference.version}</p>{'percent' in witness.reference&&<p>نسبة المرجع المحفوظة: <SavedQuantity value={witness.reference.percent} unit="%"/></p>}<p>تحقق المصدر: {witness.reference.sourceVerification} · المراجعة المسجلة: {witness.reference.review}</p></>:<p>لا مرجع سكاني محفوظ لهذه النتيجة؛ لا يُضاف مرجع حالي.</p>}
    </details>
  </div>;
}
