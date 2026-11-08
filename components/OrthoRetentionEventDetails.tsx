import type { RetentionEvent, RetentionEventArch } from "@/lib/ortho-retention-events";
export const kinds:Record<RetentionEvent['kind'],string>={debond:'فك الجهاز التقويمي',device_delivery:'تسليم مثبت',device_replacement:'استبدال مثبت',device_review:'مراجعة مثبت',device_repair:'إصلاح مثبت',device_status_change:'توثيق حالة مثبت',followup_intent:'نية متابعة'};
export const arches:Record<RetentionEventArch,string>={upper:'العلوي',lower:'السفلي',legacy_unknown:'غير معلوم'};
export const observations={fit:'الملاءمة',breakage:'الكسر',loss:'الفقد',hygiene:'النظافة',adherence:'الالتزام',relapse:'الارتداد'};
export const states={in_use:'قيد الاستخدام حسب التوثيق',not_in_use:'غير مستخدم حسب التوثيق',lost:'مفقود',removed:'أزيل',unknown:'غير معلوم',replaced:'استُبدل',ambiguous:'توقيت أو أدلة ملتبسة'};
export const provenance={unknown:'تاريخ غير معلوم',contemporaneous_record:'سجل معاصر للحدث',retrospective_record:'توثيق بأثر رجعي',historical_source:'مصدر تاريخي'};
/** Documentary facts only: rendering never manufactures wearing, completion or appointments. */
export function RetentionEventDetails({event:e}:{event:RetentionEvent}) {
 const ref='device' in e?e.device:e.kind==='device_replacement'?e.replaces:null;
 return <div className="space-y-1 text-sm"><p>{kinds[e.kind]} · {e.occurrence.occurredOn??'التاريخ غير معلوم'} · {provenance[e.occurrence.dateProvenance]}</p><p>{e.occurrence.sourceNote}</p>
 {ref&&<p>الجهاز #{ref.deviceId} · النسخة المشار إليها #{ref.expectedDeviceRevisionId}</p>}
 {'extent' in e&&<p>النطاق: {e.extent}</p>}{'description' in e&&<p>{e.description}</p>}
 {'deviceType' in e&&<p>النوع: {e.deviceType==='fixed'?'ثابت':e.deviceType==='removable'?'متحرك':'آخر'}</p>}
 {e.kind==='device_status_change'&&<p>{states[e.status]}</p>}
 {e.kind==='device_review'&&Object.entries(e.observations).map(([k,o])=><p key={k}>{observations[k as keyof typeof observations]}: {o.state==='recorded'?'موثّق':o.state==='unknown'?'غير معلوم':'لم يُقيّم'} · {o.note}</p>)}
 {e.kind==='followup_intent'&&<><p>نية متابعة فقط؛ لا تثبت الحجز أو الحضور أو الإنجاز.</p><p>{e.scope} · التاريخ المقصود: {e.dueOn??'غير محدد'} · الفترة: {e.intervalDays===null?'غير محددة':`${e.intervalDays} يوم`}</p></>}
 <p>{e.note}</p>{e.documentIds.length>0&&<p>مراجع المستندات: {e.documentIds.join('، ')}</p>}</div>;
}
