"use client";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { APPLIANCE_LABEL, ARCHES_LABEL, PHASE_LABEL, SLOT_LABEL } from "@/lib/ortho";
import { readIntakeJson, readIntakeResponse, type IntakeEvent } from "@/lib/ortho-assessment-intake-client";
import type { IntakeOwner, IntakeRequest } from "@/lib/ortho-assessment-intake-owner";
import { readIntakeEditor, intakeEditorCommand, type IntakeEditorDraft } from "@/lib/ortho-assessment-intake-editor";
const inputClass="min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100";
const buttonClass="min-h-11 min-w-11 rounded border px-4 py-2 text-sm font-semibold disabled:opacity-50";
const TIMEOUT=20_000;
export interface OrthoAssessmentIntakeProps {
  owner: IntakeOwner;
  onSaved(event: IntakeEvent): void;
  confirmDiscard(): boolean;
}
/** Real canonical intake writer, with a separately owned immutable retry lifetime. */
export function OrthoAssessmentIntake({owner,onSaved,confirmDiscard}:OrthoAssessmentIntakeProps) {
  const readVersion=owner.readVersion;
  const view=useMemo(()=>({active:false}),[owner,readVersion]);
  const [,redraw]=useState(0),[notice,setNotice]=useState(""),[loading,setLoading]=useState(true);
  useLayoutEffect(()=>{view.active=true;const unsubscribe=owner.subscribe(()=>redraw(v=>v+1));return()=>{view.active=false;unsubscribe();};},[owner,view]);
  const lease=owner.lease(),read=owner.read;
  const current=()=>view.active&&lease.current();
  const initialAction=owner.scope.selectedOrthoCaseId===null?"open":"activate";
  const draft=readIntakeEditor(lease.document,initialAction);
  const endpoint=`/api/ortho/intake?patientId=${owner.scope.patientId}`;
  useEffect(()=>{
    const captured=owner.lease(),controller=new AbortController();let alive=true;
    const currentRead=()=>alive&&view.active&&captured.current();
    const timer=setTimeout(()=>controller.abort(),TIMEOUT);setLoading(true);setNotice("");
    void(async()=>{try{
      if(!currentRead())return;
      const response=await fetch(endpoint+(owner.scope.selectedOrthoCaseId===null?"":`&orthoCaseId=${owner.scope.selectedOrthoCaseId}`),{cache:"no-store",signal:controller.signal});
      if(!currentRead())return;
      if(response.status===401||response.status===403){owner.denied();return;}
      if(!response.ok||response.redirected)throw Error("read");
      const raw=await readIntakeJson(response);if(!currentRead())return;
      const verified=await readIntakeResponse(raw,{patientId:owner.scope.patientId,...(owner.scope.selectedOrthoCaseId===null?{}:{orthoCaseId:owner.scope.selectedOrthoCaseId,clinicalCaseId:owner.scope.selectedClinicalCaseId!})});
      if(!currentRead())return;
      if(!verified||!captured.acceptRead(verified))throw Error("read");
      if(alive&&view.active)setLoading(false);
    }catch{if(currentRead()){setNotice("تعذّر التحقق من بداية الحالة. لم يُعتبر السجل فارغًا ولم تُفتح حالة أخرى.");setLoading(false);}}
    finally{clearTimeout(timer);}})();
    return()=>{alive=false;clearTimeout(timer);controller.abort();};
  },[owner,view,endpoint]);
  const change=<K extends keyof IntakeEditorDraft>(key:K,value:IntakeEditorDraft[K])=>{
    if(!current()||!draft)return;
    const next={...draft,[key]:value};
    // A changed appliance makes bracket facts explicitly inapplicable, never inherited.
    if(key==="appliance"&&value!=="fixed_metal"&&value!=="fixed_ceramic"){next.slot="";next.bracketSystem="";}
    if(lease.change(JSON.stringify(next)))setNotice("");
  };
  const transport=async(request:IntakeRequest)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);let acknowledged=false;
    try{
      if(!request.current())return;
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:request.body,signal:controller.signal});
      if(!request.checkHeaders(response))return;
      const raw=await readIntakeJson(response);if(!request.current())return;
      if(response.redirected){request.markUncertain();return;}
      if(response.ok){acknowledged=await request.confirmResponse(raw,response.status);if(!acknowledged)request.markUncertain();}
      else if(!request.refuse(raw,response.status))request.markUncertain();
      if(view.active&&!acknowledged)setNotice("لم يتأكد الحفظ. راجع التنبيه والطلب المحتفظ به؛ لا تنشئ طلبًا بديلًا تلقائيًا.");
    }catch{request.markUncertain();if(view.active)setNotice("تعذّر تأكيد نتيجة الحفظ. الطلب الأصلي محفوظ في هذه الجلسة للتحقق بإعادته نفسها.");}
    finally{
      clearTimeout(timer);request.finish();
      if(view.active&&acknowledged&&owner.confirmed)onSaved(owner.confirmed.event);
    }
  };
  const submit=(event:React.FormEvent)=>{
    event.preventDefault();if(!current()||!draft||!read)return;
    const command=intakeEditorCommand(draft,read,`intake_${crypto.randomUUID().replaceAll("-","")}`);
    if(!command.ok){setNotice(command.message);return;}
    const request=lease.begin({command:command.value,read});
    if(!request){setNotice("تغيرت الحالة أو توجد نتيجة غير مؤكدة أو بلغ حفظ الاستعادة حده؛ لم يُرسل طلب جديد.");return;}
    setNotice("");void transport(request);
  };
  const retry=()=>{if(!current())return;const request=lease.beginRetry();if(request)void transport(request);};
  const discard=()=>{if(!current()||!confirmDiscard()||!current())return;if(lease.discard())setNotice("");};
  const reload=()=>{if(current()&&!owner.busy)owner.invalidateRead();};
  const editable=!!read?.writable&&owner.editable();
  const first=read?.history[0],canCancel=first?.content.command.kind==="open_assessment"&&first.content.command.bridge.mode==="new";
  const selectedPlan=read?.plans.find(p=>String(p.id)===draft?.financialPlan);
  const existing=read?.openCase;
  return <section dir="rtl" aria-label="بداية حالة التقويم" className="min-w-0 space-y-3 rounded-xl border bg-white p-4">
    <h3 className="font-bold">{owner.scope.selectedOrthoCaseId===null?"بدء تقييم حالة تقويم":"توثيق بداية العلاج أو إلغاء التقييم"}</h3>
    <p className="text-sm">التقييم يُحفظ دون افتراض جهاز أو فك أو تاريخ بدء علاج. الاتفاق المالي والموافقة يُراجعان من مساراتهما الحالية.</p>
    {owner.recoveryBlocked?<p role="alert">يوجد طلب سابق لم تُحسم نتيجته لهذا السياق. لا يمكن استبداله من حساب أو هوية مريض أخرى.</p>:null}
    {owner.uncertain?<div role="alert" className="space-y-2 rounded border border-amber-500 p-3"><p>نتيجة الطلب السابق غير مؤكدة. إعادته تستخدم نفس المعرّف والبيانات، ولا تنشئ طلبًا مختلفًا.</p><button type="button" className={buttonClass} disabled={owner.busy||owner.retired} onClick={retry}>التحقق بإعادة الطلب الأصلي</button></div>:null}
    <p className="text-xs text-slate-600">استعادة الطلب هنا مؤقتة في الذاكرة؛ إعادة تحميل المتصفح أو إغلاقه قد تفقدها. تحذير المغادرة لا يثبت نتيجة الحفظ.</p>
    <button type="button" className={buttonClass} disabled={owner.busy||owner.retired} onClick={reload}>تحديث بداية الحالة</button>
    {loading?<p role="status">جارٍ التحقق من هوية الحالة والاتفاقات المتاحة…</p>:null}
    {notice?<p role="alert">{notice}</p>:null}
    {read?.choicesTruncated?<p role="alert">القائمة تتجاوز حد العرض؛ يلزم مراجعة اختيار الحالة قبل فتح تقييم جديد.</p>:null}
    {existing&&owner.scope.selectedOrthoCaseId===null?<p role="status">توجد حالة تقويم مفتوحة بالفعل برقم {existing.orthoCaseId}. اخترها من قائمة الحالات؛ لم تُفتح حالة ثانية.</p>:null}
    {read?.history.map(event=><p key={event.id} className="text-sm">{event.kind==="assessment_opened"?"فتح تقييم":event.kind==="assessment_activated"?"توثيق بدء العلاج":"إلغاء التقييم"} · {event.recordedAt} · {event.recordedBy} · {event.reason}</p>)}
    {read&&!draft?<p role="alert">المسودة المحلية غير قابلة للتحقق؛ لم تُستبدل بنموذج فارغ.</p>:null}
    {read&&draft&&(owner.scope.selectedOrthoCaseId===null?!existing:existing?.status==="assessment")?<form onSubmit={submit} className="space-y-3">
      <fieldset disabled={!editable} className="min-w-0 space-y-3">
        {owner.scope.selectedOrthoCaseId===null?<>
          <label className="block">سياق الحالة<select aria-label="سياق التقييم" className={inputClass} value={draft.intakeKind} onChange={e=>change("intakeKind",e.target.value as IntakeEditorDraft["intakeKind"])}><option value="unknown">غير معلوم بعد</option><option value="new">حالة جديدة بحسب التاريخ المأخوذ</option><option value="transferred">حالة محولة أو بدأ علاجها سابقًا</option></select></label>
          <label className="block">الحالة السريرية<select aria-label="الحالة السريرية للتقييم" className={inputClass} value={draft.bridge} onChange={e=>change("bridge",e.target.value)}><option value="">اختر صراحةً</option>{read.clinicalCases.length===0?<option value="new">حلقة تقييم سريرية جديدة</option>:read.clinicalCases.map(c=><option key={c.id} value={c.id}>#{c.id} · {c.title} · {c.site??"النطاق غير مسجل"}</option>)}</select></label>
        </>:<label className="block">الإجراء<select aria-label="إجراء مرحلة التقييم" className={inputClass} value={draft.action} onChange={e=>change("action",e.target.value as IntakeEditorDraft["action"])}><option value="activate">توثيق بداية العلاج على نفس الحالة</option>{canCancel?<option value="cancel">إلغاء حلقة التقييم الجديدة</option>:null}</select></label>}
        {draft.action==="activate"?<>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">{([["appliance","الجهاز",APPLIANCE_LABEL],["arches","نطاق العلاج",ARCHES_LABEL],["phase","مرحلة العلاج",PHASE_LABEL]] as const).map(([field,label,options])=><label key={field}>{label}<select aria-label={label} className={inputClass} value={draft[field]} onChange={e=>change(field,e.target.value)}><option value="">اختر صراحةً</option>{Object.entries(options).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>)}</div>
          {(draft.appliance==="fixed_metal"||draft.appliance==="fixed_ceramic")?<div className="grid gap-3 sm:grid-cols-2"><label>مقاس الشق<select aria-label="مقاس شق بداية العلاج" className={inputClass} value={draft.slot} onChange={e=>change("slot",e.target.value)}><option value="">غير معلوم</option>{Object.entries(SLOT_LABEL).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>نظام الحاصرات<input aria-label="نظام الحاصرات" className={inputClass} value={draft.bracketSystem} maxLength={80} onChange={e=>change("bracketSystem",e.target.value)}/></label></div>:null}
          <label className="block">تاريخ بدء العلاج<select aria-label="دليل تاريخ بدء العلاج" className={inputClass} value={draft.startState} onChange={e=>change("startState",e.target.value as IntakeEditorDraft["startState"])}><option value="">اختر حالة المعلومة</option><option value="known">معلوم ومسجل</option><option value="unknown">مجهول</option></select></label>
          {draft.startState==="known"?<label className="block">التاريخ الفعلي<input aria-label="التاريخ الفعلي لبدء العلاج" type="date" className={inputClass} value={draft.startDate} onChange={e=>change("startDate",e.target.value)}/></label>:draft.startState==="unknown"?<label className="block">سبب عدم معرفة التاريخ<textarea aria-label="سبب جهل تاريخ البدء" className={inputClass} maxLength={500} value={draft.startReason} onChange={e=>change("startReason",e.target.value)}/></label>:null}
          <label className="block">المدة المخططة بالأشهر، إن كانت معلومة<input aria-label="المدة المخططة عند البدء" inputMode="numeric" className={inputClass} value={draft.plannedMonths} onChange={e=>change("plannedMonths",e.target.value)}/></label>
          <label className="block">الاتفاق المالي القائم<select aria-label="الاتفاق المالي عند البدء" className={inputClass} value={draft.financialPlan} disabled={!read.canLinkPlan||!editable} onChange={e=>change("financialPlan",e.target.value)}><option value="">لم يُربط اتفاق في هذا التدوين</option>{read.plans.map(p=><option key={p.id} value={p.id}>#{p.id} · {p.title}</option>)}</select></label>
          <p className="text-sm">{selectedPlan?.consent==="recorded"?"يوجد تسجيل موافقة في الاتفاق المختار؛ تبقى حراس الإجراء والتوقيع قائمة.":"لا توجد موافقة مسجلة في الاختيار الحالي. هذا التدوين لا ينشئ موافقة ولا فاتورة أو تحصيلًا."}</p>
        </>:null}
        <label className="block">سبب التدوين<textarea aria-label="سبب تدوين بداية الحالة" className={inputClass} maxLength={500} value={draft.reason} onChange={e=>change("reason",e.target.value)}/></label>
        <button type="submit" className={buttonClass}>{draft.action==="open"?"حفظ بداية التقييم":draft.action==="activate"?"توثيق بداية العلاج":"إلغاء التقييم بسبب موثق"}</button>
        <button type="button" className={`${buttonClass} ms-2`} onClick={discard}>تجاهل المسودة صراحةً</button>
      </fieldset>
    </form>:null}
    {existing?.status==="assessment"&&!canCancel?<p className="text-sm">هذا التقييم مرتبط بحلقة سريرية سابقة. إلغاؤه يحتاج مراجعة مستقلة حتى لا يُلغى علاج سابق.</p>:null}
    {existing?.status==="assessment_cancelled"?<p role="status">التقييم ملغى. يبقى التوثيق الاستعادي متاحًا؛ استئنافه على نفس المعرّف لم يُنفذ بعد.</p>:null}
  </section>;
}
