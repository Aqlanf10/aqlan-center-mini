/** Saved documentary facts only. No draft input, clinical recommendation or
 * substitution of current session/baseline values for captured witnesses. */
import type {SpaceLedgerRead,SpaceRevision} from './ortho-space-client';
import {spaceBudget,contactKey} from './ortho-space-ledger';
export const spacePrintAmount=(um:number|null)=>um===null?'غير معلوم':`${um/1000} mm`;
const arch=(value:string)=>value==='upper'?'العلوي':'السفلي';
const methods:Record<string,string>={expansion:'توسيع',distalization:'إرجاع خلفي',uprighting:'تصحيح الميل',derotation:'تصحيح الدوران',proclination:'إمالة أمامية',extraction:'قلع مخطط',other:'تقدير آخر'};
export function spacePrintHref(data:SpaceLedgerRead):string|null{
 const head=data.history[0];if(!head||head.id!==data.headId)return null;
 return `/print/ortho-space/${data.scope.orthoCaseId}?patientId=${data.scope.patientId}&clinicalCaseId=${data.scope.clinicalCaseId}&headId=${head.id}&headHash=${head.contentHash}`;
}
export function spacePrintReport(data:SpaceLedgerRead){
 const current=new Set(data.ipr.current.map(e=>e.id));
 const latestPlans=new Set(['upper','lower'].flatMap(a=>{const p=data.history.find(h=>h.content.authored.kind==='plan'&&h.content.authored.arch===a);return p?[p.id]:[];}));
 const entry=(r:SpaceRevision)=>{
  const c=r.content.authored,lines=[`النسخة ${r.version} · بنية الشاهد المحفوظ ${r.schemaVersion} · القيد #${r.id} · الفك ${arch(c.arch)}`,`التسجيل: ${r.createdAt} · بواسطة: ${r.createdBy}`,`سبب التسجيل: ${r.reason}`,`سياق التسجيل: ${r.recordingContext==='retrospective'?'توثيق بأثر رجعي':'حالي'} · حالة الملف عند التسجيل: ${r.caseStatusAtCapture}`];
  if(c.kind==='plan'){
   const baseline=r.content.baseline!;const budget=spaceBudget(c,baseline.discrepancyMm);
   lines.push(latestPlans.has(r.id)?'آخر خطة محفوظة لهذا الفك':'خطة تاريخية؛ لا تستبدل الخطة الأحدث',`مرجع القياسات: #${c.baseline.id} · ${c.baseline.member} · ${c.baseline.version}`,`الاستراتيجية المحفوظة: #${c.strategyRevisionId}`,`المتاح ناقص المطلوب ${baseline.estimated?'المقدّر':'المقاس'}: ${baseline.discrepancyMm} mm`,`المكاسب المخططة شاملة مساهمة IPR: ${spacePrintAmount(budget.gainsUm)}`,`الاستخدامات الإضافية المخططة: ${spacePrintAmount(budget.usesUm)}`,`الرصيد التقديري بعد الخطة: ${budget.estimatedBalanceMm===null?'غير مكتمل':budget.estimatedBalanceMm+' mm'}`,`المبرر: ${c.rationale}`,`البدائل: ${c.alternatives}`);
   const sourceCurrent=data.baselines.some(b=>b.ref.id===c.baseline.id&&b.ref.member===c.baseline.member&&b.ref.version===c.baseline.version);
   if(!sourceCurrent||data.strategy?.id!==c.strategyRevisionId)lines.push('تغير مصدر القياسات أو الاستراتيجية الحالية؛ المعروض هو المرجع التاريخي المحفوظ ويحتاج مراجعة الطبيب.');
   for(const g of c.gains)lines.push(`مكسب مخطط: ${methods[g.method]} · ${g.label} · ${spacePrintAmount(g.estimateUm)} · ${g.included?'محتسب':'غير محتسب / بديل'} · مجموعة التداخل: ${g.overlapGroup} · ${g.rationale}`);
   for(const u of c.uses)lines.push(`استخدام مخطط: ${u.label} · ${spacePrintAmount(u.amountUm)}`);
   for(const p of c.contacts)lines.push(`التماس ${contactKey(p.teeth)} · IPR مخطط: ${spacePrintAmount(p.plannedUm)} · المساهمة الإضافية في الميزانية: ${spacePrintAmount(p.budgetGainUm)} · حد أدخله الطبيب: ${spacePrintAmount(p.clinicianLimitUm)} · ${p.note}`);
  }else{
   const witness=r.content.adjustment!;
   lines.push(current.has(r.id)?'واقعة مدرجة في المجموع الوثائقي الحالي':'واقعة تاريخية استُبدلت بتصحيح؛ غير محتسبة مجدداً',`التماس: ${contactKey(c.teeth)} · المقدار المنفذ الموثق: ${spacePrintAmount(c.performedUm)}`,`الخطة الأصلية المرتبطة: #${c.planEntryId}`,`الجلسة الفعلية: #${c.adjustmentId} · الزيارة المحفوظة: #${witness.visitId}`,`تاريخ الجلسة المحفوظ: ${witness.occurredOn} · مسجلها المحفوظ: ${witness.recordedBy}`,`ملاحظة القياس: ${c.measurementNote}`,`تصحيح للقيد: ${c.supersedesEntryId===null?'لا يوجد':'#'+c.supersedesEntryId}`,`سبب المراجعة الموثق: ${c.reviewReason??'غير مسجل'}؛ ليس موافقة علاجية`);
  }
  return {id:r.id,title:c.kind==='plan'?'ميزانية مسافات مخططة':'IPR منفذ موثق',lines,hash:r.contentHash};
 };
 return {headId:data.headId,scope:data.scope,totals:data.ipr.totals.map(t=>`الفك ${arch(t.arch)} · التماس ${t.contact} · مجموع الأحداث الحالية الموثقة: ${spacePrintAmount(t.performedUm)}`),entries:[...data.history].reverse().map(entry)};
}
