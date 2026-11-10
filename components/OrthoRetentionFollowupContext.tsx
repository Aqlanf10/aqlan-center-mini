import type {RetentionFollowupContext} from '@/lib/ortho-retention-followup-context';
const archLabel={upper:'الفك العلوي',lower:'الفك السفلي',legacy_unknown:'الفك غير معروف'};
const provenance={contemporaneous_record:'تسجيل معاصر',retrospective_record:'تسجيل لاحق',historical_source:'مصدر تاريخي',unknown:'تاريخ غير معروف'};
const reasons:Record<string,string>={interval_anchor_unknown:'تاريخ بداية الفترة غير معروف',interval_date_out_of_range:'التاريخ خارج النطاق',conflicting_timing:'تعارض التاريخ والفترة',due_precedes_instruction:'التاريخ المقصود يسبق التعليمة',arch_unknown:'الفك غير معروف',overlapping_instructions:'تعليمات متداخلة',device_state_requires_reconciliation:'حالة الجهاز تحتاج مراجعة',device_arch_changed:'تغير فك الجهاز',device_replaced_requires_reconciliation:'استُبدل الجهاز؛ راجع التعليمة'};
const Day=({value}:{value:string|null})=>value?<bdi dir="ltr">{value}</bdi>:<>غير معروف</>;
/** Shared board/print rendering of documentary facts, with no action or inference. */
export function OrthoRetentionFollowupContext({context,print=false}:{context?:RetentionFollowupContext;print?:boolean}){
 if(!context||context.state==='unavailable')return <div className="space-y-1"><p>موعد مراجعة التثبيت غير متاح في هذه اللوحة؛ تعذّر التحقق من تعليمات التثبيت أو مصادرها ضمن القراءة الحالية.</p><p>لم يُفترض من فاصل الشدّات. الحجز لا يثبت إتمام مراجعة التثبيت.</p></div>;
 return <div className="space-y-2">
  <p>تعليمات ومراجعات تثبيت موثقة؛ لا تثبت حجزاً أو إنجازاً أو إلغاءً. مراجعة الجهاز لا تُغلق تعليمة سابقة تلقائياً.</p>
  {context.sourceEvidence==='mismatch'?<p role="status">تغير أحد المصادر عن الدليل المحفوظ؛ التواريخ أدناه حقائق تاريخية وليست تحققاً من المصدر الحالي.</p>:context.sourceEvidence==='unverified'?<p role="status">بعض المصادر التاريخية بلا شاهد هوية محفوظ.</p>:null}
  {context.instructionState==='not_recorded'?<p>لا توجد نية متابعة موثقة في هذا السجل.</p>:context.instructionState==='ambiguous'?<p>تعليمات غير محسومة؛ لا يمكن جمعها في تاريخ متابعة واحد.</p>:<p>أقدم تاريخ مقصود ضمن التعليمات المسجلة: <Day value={context.earliestRecordedDate}/>. إنجازها غير مثبت.</p>}
  <details open={print} className="text-sm"><summary className="cursor-pointer py-2 font-semibold">تعليمات ومراجعات التثبيت المسجلة</summary><div className="space-y-3">
  <ul className="space-y-2">{context.instructions.map(i=><li key={i.eventId}>
   {archLabel[i.arch]} · {i.deviceId===null?'تعليمة للفك دون جهاز محدد':<>الجهاز #{i.deviceId}</>} · التعليمة #{i.eventId}
   <p>تاريخ التعليمة: <Day value={i.timing.occurredOn}/> · {provenance[i.timing.dateProvenance]}{i.retrospective?' · وُثقت والحالة مغلقة':''}</p>
   <p>التاريخ المقصود الصريح: <Day value={i.dueOn}/> · الفترة المسجلة: {i.intervalDays===null?'غير محددة':`${i.intervalDays} يوم`} · التاريخ المستخلص من التعليمة: <Day value={i.resolvedDate}/></p>
   {i.ambiguityReasons.length?<p>{i.ambiguityReasons.map(reason=>reasons[reason]??'تحتاج التعليمة مراجعة').join('؛ ')}</p>:null}
  </li>)}</ul>
  <ul className="space-y-1">{context.devices.map(d=><li key={d.deviceId}>
   الجهاز #{d.deviceId} · {archLabel[d.arch]} · مراجعات موثقة:
   {d.reviews.length?<ul>{d.reviews.map(r=><li key={r.eventId}>المراجعة #{r.eventId}: <Day value={r.timing.occurredOn}/> · {provenance[r.timing.dateProvenance]}{r.retrospective?' · وُثقت والحالة مغلقة':''}</li>)}</ul>:<span> لا توجد مراجعات مسجلة لهذا الجهاز.</span>}
  </li>)}</ul>
  </div></details>
 </div>;
}
