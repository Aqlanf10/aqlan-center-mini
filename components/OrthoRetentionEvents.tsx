"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { OrthoRetentionEventEditor, RETENTION_EVENT_LABELS } from "./OrthoRetentionEventEditor";
import { OrthoRetentionDocumentPicker } from "./OrthoRetentionDocumentPicker";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { correctRetentionEvent, initialRetentionEditor, retentionDraftTargetIsCurrent, retentionEditorCommand } from "@/lib/ortho-retention-editor";
import { readRetentionEditorDocument } from "@/lib/ortho-retention-editor-document";
import { readRetentionResponseJSON, verifyRetentionRead, type RetentionRevision } from "@/lib/ortho-retention-client";
import { sendRetentionCommand, hasRetentionNoStore } from "@/lib/ortho-retention-transport";
import type { RetentionMountOwner } from "@/lib/ortho-retention-mount-owner";
import type { RetentionEvent } from "@/lib/ortho-retention-events";
const button = "min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-900 disabled:opacity-50";
const archLabel = { upper: "الفك العلوي", lower: "الفك السفلي", legacy_unknown: "فك تاريخي غير معلوم" } as const;
const stateLabel = { in_use: "استخدام موثق", not_in_use: "عدم استخدام موثق", lost: "فقد موثق", removed: "إزالة موثقة", replaced: "استبدال موثق", unknown: "الحالة غير معلومة", ambiguous: "التسلسل الزمني أو الحالة غير محسومين" } as const;
function RecordedEvent({event}:{event:RetentionEvent}) {
  return <div className="min-w-0 space-y-1 break-words text-sm">
    <p>{RETENTION_EVENT_LABELS[event.kind]} · التاريخ السريري: {event.occurrence.occurredOn ?? "غير معلوم"}</p>
    <p className="text-xs text-slate-600">دليل التاريخ: {event.occurrence.dateProvenance === "unknown" ? "غير معلوم" : event.occurrence.dateProvenance === "historical_source" ? "مصدر تاريخي" : event.occurrence.dateProvenance === "retrospective_record" ? "تدوين استعادي" : "تدوين وقت الحدث"}{event.occurrence.sourceNote ? ` · ${event.occurrence.sourceNote}` : ""}</p>
    {"deviceType" in event ? <p>نوع الجهاز: {event.deviceType==="fixed"?"ثابت":event.deviceType==="removable"?"متحرك":"نوع آخر موصوف"}</p>:null}
    {"description" in event ? <p>{event.description}</p> : null}{"extent" in event ? <p>الامتداد المسجل: {event.extent}</p> : null}
    {"device" in event && event.device ? <p>الجهاز #{event.device.deviceId} · المرجع وقت التدوين #{event.device.expectedDeviceRevisionId}</p> : null}
    {event.kind === "device_replacement" ? <p>بديل للجهاز #{event.replaces.deviceId} · المرجع وقت التدوين #{event.replaces.expectedDeviceRevisionId}</p> : null}
    {event.kind === "device_status_change" ? <p>{stateLabel[event.status]}</p> : null}
    {event.kind === "device_review" ? <dl className="grid gap-1 sm:grid-cols-2">{Object.entries(event.observations).map(([key,value]) => <div key={key}>
      <dt>{({fit:"الملاءمة",breakage:"الكسر",loss:"الفقد",hygiene:"النظافة",adherence:"الالتزام",relapse:"الانتكاس"} as Record<string,string>)[key]}</dt>
      <dd>{value.state === "recorded" ? "نتيجة موصوفة" : value.state === "unknown" ? "غير معلوم" : "لم يُقيّم"}{value.note ? ` · ${value.note}` : ""}</dd></div>)}</dl> : null}
    {event.kind === "followup_intent" ? <p>نية متابعة غير محجوزة: {event.scope} · التاريخ {event.dueOn ?? "غير محدد"} · الفاصل {event.intervalDays === null ? "غير محدد" : `${event.intervalDays} يومًا`}</p> : null}
    {event.note ? <p className="whitespace-pre-wrap">{event.note}</p> : null}
    {event.documentIds.length ? <p className="text-xs">مراجع المستندات المحفوظة: {event.documentIds.map(id=>`#${id}`).join("، ")}</p> : null}
  </div>;
}
/** Current canonical GET + exact immutable POST. Parent owns the case lifetime. */
export function OrthoRetentionEvents({owner,confirmDiscard}:{owner:RetentionMountOwner;confirmDiscard():boolean}) {
  const [,redraw]=useState(0),[retry,setRetry]=useState(0),[notice,setNotice]=useState<{owner:RetentionMountOwner;generation:number;version:number;text:string}|null>(null);
  const [historical,setHistorical]=useState<{owner:RetentionMountOwner;generation:number;version:number;revision:RetentionRevision}|null>(null);
  const [pages,setPages]=useState<{owner:RetentionMountOwner;generation:number;version:number;devices:number;events:number;history:number}|null>(null);
  const historyRequest=useRef<AbortController|null>(null),committed=useRef<object|null>(null),snapshot={};
  const generation=owner.generation,version=owner.readVersion,retention=owner.retention,read=owner.read,document=retention?.document??"";
  const draft=document ? readRetentionEditorDocument(document) : read ? initialRetentionEditor(read) : null;
  useLayoutEffect(()=>owner.subscribe(()=>redraw(value=>value+1)),[owner]);
  useLayoutEffect(()=>{committed.current=snapshot;return()=>{if(committed.current===snapshot)committed.current=null;};},[snapshot]);
  useLayoutEffect(()=>()=>{historyRequest.current?.abort();historyRequest.current=null;},[owner,generation,version]);
  const viewCurrent=()=>committed.current===snapshot&&owner.generation===generation&&owner.readVersion===version;
  const current=()=>viewCurrent()&&owner.current()&&owner.generation===generation&&owner.readVersion===version
    &&owner.retention===retention&&!!retention?.active()&&retention.document===document;
  useLayoutEffect(()=>{if(retention&&read&&retention.document===""&&!retention.busy&&!retention.uncertain&&!retention.recoveryBlocked)
    retention.settle(canonicalJourneyJSON(initialRetentionEditor(read)));},[retention,read]);
  useLayoutEffect(()=>{
    if(owner.read)return;
    const lease=owner.beginRead();if(!lease)return;
    const controller=new AbortController();let attached=true;
    const live=()=>attached&&!controller.signal.aborted&&lease.current();
    const timer=setTimeout(()=>{const mayReport=attached&&lease.current();lease.cancel();controller.abort();if(mayReport&&owner.current()&&owner.generation===generation&&owner.readVersion===version)setNotice({owner,generation,version,text:"تعذّر إكمال قراءة سجل التثبيت. أعد القراءة؛ لم يُعتبر السجل فارغًا."});},20_000);
    void(async()=>{try{
      const response=await fetch(`/api/ortho/${owner.orthoCaseId}/retention-events?patientId=${owner.patientId}`,{credentials:"same-origin",cache:"no-store",redirect:"error",signal:controller.signal});
      if(!live())return;if(response.status===401||response.status===403){lease.denied();return;}
      if(!response.ok||!hasRetentionNoStore(response))throw new Error("retention_read_unavailable");
      const raw=await readRetentionResponseJSON(response);if(!live())return;
      if(!await lease.accept(raw)&&live())throw new Error("retention_read_changed");
    }catch{if(live())setNotice({owner,generation,version,text:"تعذّر التحقق من سجل التثبيت أو صلاحية مصادره. احتُفظ بالمسودة والطلب الأصلي إن وُجدا."});}
    finally{clearTimeout(timer);}})();
    return()=>{attached=false;lease.cancel();clearTimeout(timer);controller.abort();};
  },[owner,generation,version,retry]);
  const message=notice?.owner===owner&&notice.generation===generation&&notice.version===version?notice.text:null;
  const show=(text:string)=>{if(current())setNotice({owner,generation,version,text});};
  const discard=()=>{
    if(!current()||!retention||!read)return;
    if(retention.canLeave(()=>confirmDiscard()&&current())&&committed.current===snapshot&&owner.current()&&owner.generation===generation&&owner.readVersion===version&&owner.retention===retention)retention.settle(canonicalJourneyJSON(initialRetentionEditor(read)));
  };
  const correct=(eventId:number)=>{
    if(!current()||!retention?.editable()||!read)return;
    if(retention.dirty&&!retention.canLeave(()=>confirmDiscard()&&current()))return;
    if(!owner.current()||owner.generation!==generation||owner.readVersion!==version||owner.retention!==retention)return;
    try{retention.change(canonicalJourneyJSON(correctRetentionEvent(read,eventId)));}catch{show("تعذّر بدء تصحيح هذا السجل؛ لم تُغيّر هوية الجهاز.");}
  };
  const save=async(replay:boolean)=>{
    if(!current()||!retention||!read||!draft)return;
    let lease;
    try{
      if(replay)lease=retention.beginRetry();
      else{
        if(!retention.editable()||!retentionDraftTargetIsCurrent(draft,read))return;
        const parsed=retentionEditorCommand(draft,crypto.randomUUID());
        if(!parsed.ok){show("أكمل نوع التدوين والفك والحقول المطلوبة وسبب الحفظ، أو اترك التاريخ مجهولًا صراحةً.");return;}
        lease=retention.begin({scope:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:read.clinicalCaseId},actorId:owner.actorId,previousVersion:draft.previousVersion,command:parsed.value},document);
      }
      if(!lease){show("تعذّر بدء الطلب. راجع مرجع الحالة أو الطلب السابق؛ لم يُنشأ طلب بديل.");return;}
      const outcome=await sendRetentionCommand(lease);
      if(current())show(outcome==="refused"&&!retention.uncertain?"رفض الخادم الطلب قبل إقراره. احتُفظ بالحقول؛ أعد القراءة وراجع سبب التعارض.":outcome==="uncertain"||retention.uncertain?"نتيجة الحفظ غير محسومة. استخدم إعادة الطلب الأصلي قبل أي سجل جديد.":"تمت إعادة التحقق من الطلب؛ جارٍ قراءة السجل الحالي.");
    }catch{show("تعذّر بدء التدوين أو التحقق منه. لم تُعتبر النتيجة حفظًا مؤكدًا.");}
  };
  const inspect=async(id:number)=>{
    if(!current()||!retention||!read)return;
    historyRequest.current?.abort();const controller=new AbortController();historyRequest.current=controller;
    const live=()=>historyRequest.current===controller&&!controller.signal.aborted&&owner.current()&&owner.generation===generation&&owner.readVersion===version&&owner.retention===retention;
    const timer=setTimeout(()=>controller.abort(),20_000);
    try{
      const response=await fetch(`/api/ortho/${owner.orthoCaseId}/retention-events?patientId=${owner.patientId}&revisionId=${id}`,{credentials:"same-origin",cache:"no-store",redirect:"error",signal:controller.signal});
      if(!live())return;if(response.status===401||response.status===403){retention.denied();return;}
      if(!response.ok||!hasRetentionNoStore(response))throw new Error("retention_history_unavailable");
      const raw=await readRetentionResponseJSON(response);if(!live())return;
      const verified=await verifyRetentionRead(raw,{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:read.clinicalCaseId},id);
      if(live()&&verified.revision)setHistorical({owner,generation,version,revision:verified.revision});
    }catch{if(live())setNotice({owner,generation,version,text:"تعذّر التحقق من هذه النسخة التاريخية أو صلاحية مصادرها."});}
    finally{clearTimeout(timer);if(historyRequest.current===controller)historyRequest.current=null;}
  };
  if(owner.bridgeChanged)return <div role="alert" className="space-y-2 rounded-xl border border-amber-200 p-3 text-sm">
    <p>تغيّر الرابط السريري. احتُفظ بتدوين التثبيت تحت هوية المريض والحساب والرابط الأصليين؛ لا يُحفظ في رابط جديد.</p>
    <button className={button} type="button" disabled={owner.busy||owner.uncertain} onClick={()=>{if(viewCurrent()&&owner.bridgeChanged)owner.discardQuarantinedDraft(()=>confirmDiscard()&&viewCurrent()&&owner.bridgeChanged);}}>تجاهل التعديلات المحلية للرابط السابق بعد التأكيد</button>
    <p>الطلب غير المحسوم لا يُحذف بهذا الإجراء. الاستعادة مؤقتة في هذه الجلسة.</p></div>;
  if(!owner.current())return <p role="status">تعذّر التحقق من صلاحية قراءة سجل التثبيت الحالي.</p>;
  if(!retention||!read)return <div className="rounded-xl border border-slate-200 p-3"><p role={message?"alert":"status"}>{message??"جارٍ التحقق من سجل أجهزة التثبيت ورابط الحالة…"}</p>
    {message?<button type="button" className={button} onClick={()=>{if(viewCurrent()&&owner.current())setRetry(value=>value+1);}}>إعادة قراءة سجل التثبيت</button>:null}</div>;
  const old=historical?.owner===owner&&historical.generation===generation&&historical.version===version?historical.revision:null;
  const paging=pages?.owner===owner&&pages.generation===generation&&pages.version===version?pages:{devices:0,events:0,history:0};
  const pageSize=20;
  const pager=(kind:"devices"|"events"|"history",total:number)=><div className="flex flex-wrap items-center gap-2 text-xs">
    <span>عرض {total?paging[kind]*pageSize+1:0}–{Math.min(total,(paging[kind]+1)*pageSize)} من {total}</span>
    <button type="button" className={button} disabled={paging[kind]===0} onClick={()=>{if(current())setPages({...paging,owner,generation,version,[kind]:paging[kind]-1});}}>السابق</button>
    <button type="button" className={button} disabled={(paging[kind]+1)*pageSize>=total} onClick={()=>{if(current())setPages({...paging,owner,generation,version,[kind]:paging[kind]+1});}}>التالي</button>
  </div>;

  return <section dir="rtl" className="min-w-0 space-y-4" aria-label="السجل الفعلي لأجهزة التثبيت" data-testid="ortho-retention-events">
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-bold text-navy-900">سجل أجهزة التثبيت والمتابعة</h4>
      <p className="text-xs text-slate-600">كل جهاز له معرّف مستقل؛ الملخص القديم لا يثبت تسليم جهاز. آخر نسخة {read.history[0]?.version??"لا توجد"}.</p></div>
      <button className={button} type="button" disabled={retention.busy} onClick={()=>{if(current()&&!retention.busy)owner.invalidateRead();}}>تحديث سجل التثبيت</button></header>
    {message?<p role="alert" className="rounded-lg border border-amber-200 p-3 text-sm">{message}</p>:null}
    {retention.recoveryBlocked?<p role="alert">توجد تعديلات محفوظة مؤقتًا لهوية أصلية أخرى. لا يمكن قراءتها أو استبدالها من هذا السياق.</p>:null}
    {retention.uncertain?<div role="alert" className="space-y-2 rounded-lg border border-amber-200 p-3 text-sm"><p>يوجد طلب غير محسوم. احتُفظ بمعرّفه ومحتواه؛ لا تبدأ تدوينًا بديلًا.</p>
      <button type="button" className={button} disabled={!retention.canRetry()} onClick={()=>void save(true)}>التحقق بإعادة طلب التثبيت الأصلي</button></div>:null}
    <div className="grid min-w-0 gap-3 md:grid-cols-2">{read.devices.slice(paging.devices*pageSize,(paging.devices+1)*pageSize).map(device=><article key={device.deviceId} className="min-w-0 rounded-xl border border-slate-200 p-3">
      <h5 className="font-semibold">الجهاز #{device.deviceId} · {archLabel[device.arch]}</h5><p className="text-xs">نسخة التسليم #{device.deliveryRevisionId} · آخر سجل #{device.lastEventId}</p>
      <RecordedEvent event={device.delivery}/><p className="mt-2 font-semibold">{stateLabel[device.currentState]}</p>
      <p className="text-xs">بداية الفترة المسجلة {device.intervalStart??"غير معلومة"} · نهايتها {device.intervalEnd??"غير معلومة"}</p>
      {device.ambiguityReasons.length?<p className="text-xs text-amber-900">توجد {device.ambiguityReasons.length} قيود زمنية أو تعارضات في السجل. راجع الأحداث؛ لم تُفترض حالة استخدام مؤكدة.</p>:null}
    </article>)}</div>
    {read.devices.length>pageSize?pager("devices",read.devices.length):null}
    {!read.devices.length?<p className="text-sm">لا توجد أجهزة مثبتة بهوية تسليم فعلية في هذا السجل.</p>:null}
    <details className="rounded-xl border border-slate-200 p-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">الأحداث الحالية والتصحيحات ({read.currentEvents.length})</summary>
      <div className="space-y-3">{read.currentEvents.slice(paging.events*pageSize,(paging.events+1)*pageSize).map(event=><article key={event.id} className="rounded-lg border border-slate-100 p-3"><p className="text-xs">سجل #{event.id} · نسخة {event.version} · {archLabel[event.arch]}{event.supersedesEntryId!==null?` · يصحح #${event.supersedesEntryId}`:""}</p>
        <RecordedEvent event={event.content}/><button type="button" className={`${button} mt-2`} disabled={!retention.editable()} onClick={()=>correct(event.id)}>تصحيح السجل #{event.id} صراحةً</button></article>)}</div>{pager("events",read.currentEvents.length)}</details>
    <details className="rounded-xl border border-slate-200 p-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">كل النسخ التاريخية ({read.history.length})</summary>
      <div className="flex flex-wrap gap-2">{read.history.slice(paging.history*pageSize,(paging.history+1)*pageSize).map(item=><button key={item.id} className={button} type="button" onClick={()=>void inspect(item.id)}>نسخة {item.version} · #{item.id}</button>)}</div>{pager("history",read.history.length)}
      {old?<article className="mt-3 rounded-lg border border-slate-200 p-3"><p className="text-xs">نسخة {old.version} · #{old.id} · المسجل: {old.createdBy} · وقت الإدخال: {old.createdAt}</p><p>سبب التدوين: {old.reason}</p><RecordedEvent event={old.content.payload}/></article>:null}</details>
    {!retention.editable()&&!retention.busy&&!retention.uncertain&&!retention.recoveryBlocked?<p role="status" className="text-sm">القراءة متاحة؛ تدوين حدث تثبيت جديد غير متاح لصلاحية الحساب أو مرحلة الحالة الحالية.</p>:null}
    {draft?<form onSubmit={event=>{event.preventDefault();void save(false);}} className="min-w-0 space-y-3">
      <OrthoRetentionEventEditor ownerKey={owner.ownerKey} draft={draft} read={read} writable={retention.editable()} documentReferencesManaged isCurrent={current}
        onChange={request=>{if(!current()||!retention.editable()||request.ownerKey!==owner.ownerKey||request.expectedDraft!==canonicalJourneyJSON(draft))return false;
          try{const next=canonicalJourneyJSON(request.draft);if(!readRetentionEditorDocument(next))return false;retention.change(next);return retention.document===next;}catch{show("بلغت الذاكرة المؤقتة حدها أو تغيّر السياق. بقيت التعديلات السابقة محفوظة.");return false;}}}/>
      <OrthoRetentionDocumentPicker ownerIdentity={owner} ownerKey={owner.ownerKey} patientId={owner.patientId}
        orthoCaseId={owner.orthoCaseId} clinicalCaseId={read.clinicalCaseId} generation={generation} readVersion={version}
        documentIds={draft.documentIds} writable={retention.editable()} isCurrent={current}
        onDenied={()=>{if(current())retention.denied();}}
        onRestricted={()=>{if(!current())return;historyRequest.current?.abort();historyRequest.current=null;setHistorical(null);
          if(read.currentEvents.some(event=>event.content.documentIds.length>0)
            ||!!read.revision?.content.payload.documentIds.length||!!old?.content.payload.documentIds.length)owner.invalidateRead();}}
        onChange={request=>{if(!current()||!retention.editable()||request.ownerKey!==owner.ownerKey)return false;
          try{if(canonicalJourneyJSON(request.expectedDocumentIds)!==canonicalJourneyJSON(draft.documentIds))return false;
            const next=canonicalJourneyJSON({...draft,documentIds:[...request.documentIds]});if(!readRetentionEditorDocument(next))return false;
            retention.change(next);return retention.document===next;}catch{show("تعذّر تحديث مراجع المستندات؛ بقيت المسودة السابقة محفوظة.");return false;}}}/>
      {!retentionDraftTargetIsCurrent(draft,read)?<p role="alert" className="text-sm text-amber-900">تغيّر مرجع الحالة أو الجهاز بعد بدء المسودة. لم يُحدّث المرجع تلقائيًا. احتفظ بمعلوماتك وابدأ تدوينًا جديدًا بعد مراجعة السجل أو أعد الطلب الأصلي غير المحسوم.</p>:null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={`${button} bg-navy-900 text-white`} disabled={!retention.editable()||!retentionDraftTargetIsCurrent(draft,read)}>حفظ تدوين التثبيت</button>
        <button type="button" className={button} disabled={retention.busy||retention.uncertain||retention.recoveryBlocked} onClick={discard}>تجاهل المسودة وبدء تدوين جديد بعد التأكيد</button></div>
      <p className="text-xs text-slate-600">المسودة والطلب غير المحسوم محفوظان مؤقتًا أثناء التنقل داخل هذه الجلسة. إغلاق المتصفح أو إعادة تحميله قد يفقد الذاكرة المؤقتة.</p>
    </form>:<p role="alert">تعذّر قراءة المسودة المحلية. لم تُستبدل بمسودة فارغة.</p>}
  </section>;
}
