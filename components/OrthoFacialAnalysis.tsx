"use client";
import { OrthoFacialOlderHistory } from "./OrthoFacialOlderHistory";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { clinicalContextHref } from "@/lib/patient-navigation";
import { FACIAL_LANDMARKS, blankFacialContent, computeFacialResults, readFacialCommand, type FacialCommand, type FacialContent, type FacialLandmark, type FacialResults } from "@/lib/ortho-facial-analysis";
import { readFacialRead, type FacialRead } from "@/lib/ortho-facial-records";
import { bootstrapFacialRecovery, submitFacialAndAcknowledge, cancelFacialAndAcknowledge, facialCommandIdentity, type FacialSaveExpectation, type FacialSubmissionContext } from "@/lib/ortho-facial-submission-client";
import type { FacialSubmissionRecovery } from "@/lib/ortho-facial-submission-contract";
const control="min-h-11 min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
type Draft={documentId:number;expectedHeadId:number|null;content:FacialContent;reason:string};
export function OrthoFacialAnalysis({patientId,orthoCaseId}:{patientId:number;orthoCaseId:number}){
  const session=useSession(),authority=JSON.stringify([session?.userId,session?.username,session?.role,session?.permissions??null]);
  return <Workspace key={`${patientId}:${orthoCaseId}:${authority}`} patientId={patientId} orthoCaseId={orthoCaseId}/>;
}
function Results({results}:{results:FacialResults}){
  return <section aria-label="نتائج قياسات الوجه" className="space-y-3">{results.measures.map(m=><div key={m.id} className="rounded-lg border p-3">
    <h3 className="font-bold">{{thirds:"أثلاث الوجه",fifths_postaurale:"أخماس الوجه — حدود الأذن Pa",lower_third:"نسب الجزء السفلي",eye_widths:"عرض العينين والمسافة بينهما"}[m.id]}</h3>
    <p className="text-xs text-slate-600">{m.message}</p>
    {m.state==="ready"&&<ul className="mt-2 space-y-1 text-sm">{m.segments.map((s,i)=><li key={i} className="flex flex-wrap justify-between gap-2"><span>{s.label}</span><span dir="ltr">{s.percent.toFixed(1)}% · {s.pixels.toFixed(1)} px</span></li>)}</ul>}
  </div>)}</section>;
}
function Workspace({patientId,orthoCaseId}:{patientId:number;orthoCaseId:number}){
  const [documentId,setDocumentId]=useState<number|null>(null),[refresh,setRefresh]=useState(0),[historyId,setHistoryId]=useState<number|null>(null);
  const generation=useMemo(()=>({documentId,refresh}),[documentId,refresh]),committed=useRef<object|null>(null);
  useLayoutEffect(()=>{committed.current=generation;return()=>{if(committed.current===generation)committed.current=null;};},[generation]);
  const deniedRef=useRef(false);
  const current=()=>committed.current===generation&&!deniedRef.current;
  const [read,setRead]=useState<{generation:object;data:FacialRead|null;error:string|null}|null>(null);
  const data=read?.generation===generation?read.data:null,error=read?.generation===generation?read.error:null;
  const [draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState<FacialCommand|null>(null),[busy,setBusy]=useState(false),busyRef=useRef(false);
  const [uncertain,setUncertain]=useState(false),[message,setMessage]=useState<string|null>(null),[denied,setDenied]=useState(false);
  const [selected,setSelected]=useState<FacialLandmark>("axisTop"),[unavailableReason,setUnavailableReason]=useState("");
  const [loaded,setLoaded]=useState<string|null>(null);
  const [recovery,setRecovery]=useState<FacialSubmissionRecovery["recovery"]|undefined>(undefined),[recoveryConflict,setRecoveryConflict]=useState(false);
  const draftRef=useRef(draft);
  useLayoutEffect(()=>{draftRef.current=draft;},[draft]);
  const expectedRef=useRef<FacialSaveExpectation|null>(null),scopeRef=useRef<Pick<FacialSubmissionContext,"scope"|"actorId">|null>(null);
  // Recovery controls render state; the ref remains the synchronous command guard.
  const [hasExpected,setHasExpected]=useState(false);
  const publishExpected=(expected:FacialSaveExpectation|null)=>{expectedRef.current=expected;setHasExpected(expected!==null);};
  const recoveryBlocked=recovery?.state==="blocked"||recovery?.state==="cancelled"||recoveryConflict;
  const head=data?.history[0]??null,revision=data?.history.find(r=>r.id===historyId)??head;
  const stale=!!draft&&!!data&&draft.expectedHeadId!==(head?.id??null);
  const editable=!!data?.canWrite&&!!draft&&!busy&&!pending&&!denied&&!stale&&recovery!==undefined&&!recoveryBlocked;
  const content=draft?.documentId===documentId?draft.content:revision?.command.content??null;
  const image=data?.image??null,imageKey=image&&documentId?`${documentId}:${image.sha256}:${image.width}:${image.height}`:null;
  const imageReady=imageKey!==null&&loaded===imageKey;
  const renderState = {}, committedEdit = useRef<object | null>(null);
  const gesture = useRef<{ pointerId: number; landmark: FacialLandmark; imageKey: string; expectedDraft: Draft } | null>(null);
  useLayoutEffect(() => {
    committedEdit.current = renderState;
    if (gesture.current && (gesture.current.expectedDraft !== draft || gesture.current.landmark !== selected || gesture.current.imageKey !== imageKey || !editable || !imageReady)) gesture.current = null;
    return () => { if (committedEdit.current === renderState) committedEdit.current = null; };
  });
  const currentRender = () => current() && committedEdit.current === renderState;
  const endpoint=`/api/ortho/${orthoCaseId}/facial-analysis`;
  const deny=()=>{deniedRef.current=true;committedEdit.current=null;gesture.current=null;publishExpected(null);scopeRef.current=null;setDraft(null);setPending(null);setLoaded(null);setRead(null);setRecovery(undefined);setDenied(true);};
  useEffect(()=>{
    const controller=new AbortController();let live=true;
    const valid=()=>live&&!controller.signal.aborted&&committed.current===generation&&!deniedRef.current;
    const timer=setTimeout(()=>{if(valid()){setRead({generation,data:null,error:"تعذّرت القراءة؛ لا يعني ذلك أن السجل فارغ."});controller.abort();}},15000);
    void(async()=>{try{
      const metadata=await bootstrapFacialRecovery({patientId,orthoCaseId},{current:valid,deny},controller.signal);
      if(!valid())return;
      const binding={scope:metadata.scope,actorId:metadata.actorId},receipt=metadata.recovery;
      if(scopeRef.current&&(scopeRef.current.actorId!==binding.actorId||canonicalJourneyJSON(scopeRef.current.scope)!==canonicalJourneyJSON(binding.scope))||expectedRef.current&&(expectedRef.current.actorId!==binding.actorId||canonicalJourneyJSON(expectedRef.current.scope)!==canonicalJourneyJSON(binding.scope))){deny();return;}
      scopeRef.current=binding;setRecovery(receipt);setRecoveryConflict(false);
      if(receipt?.state==="blocked"||receipt?.state==="cancelled"){
        if(expectedRef.current&&(!receipt.identity||receipt.identity.commandId!==expectedRef.current.command.clientRequestId))setRecoveryConflict(true);
        setDraft(null);setPending(null);setLoaded(null);setUncertain(false);setRead({generation,data:null,error:null});return;
      }
      if(receipt?.state==="pending"||receipt?.state==="committed"){
        const local=expectedRef.current;
        if(local&&canonicalJourneyJSON(local)!==canonicalJourneyJSON(receipt.expected)||!local&&draftRef.current){
          setRecoveryConflict(true);setLoaded(null);setRead({generation,data:null,error:null});setMessage("يوجد طلب محفوظ من نافذة أخرى. راجع استعادته أو إلغاءه صراحةً قبل متابعة التحرير.");return;
        }
        const restored=receipt.expected;publishExpected(restored);setPending(restored.command);
        setDraft({documentId:restored.command.documentId,expectedHeadId:restored.command.expectedHeadId,reason:restored.command.reason,content:restored.command.content});setUncertain(true);
        setMessage("استُعيد طلب القياسات المحفوظ على الخادم. تحقّق منه بإعادة الطلب نفسه أو ألغِ الطلب المعلّق صراحةً.");
        if(documentId!==restored.command.documentId){setLoaded(null);setDocumentId(restored.command.documentId);return;}
      }
      const response=await fetch(`${endpoint}?patientId=${patientId}${documentId===null?"":`&documentId=${documentId}`}`,{cache:"no-store",signal:controller.signal});
      if(!valid())return;
      if(response.status===401){deny();return;}
      if(response.status===403){
        // Quarantine synchronously before one metadata-only recheck. A source
        // denial never authorizes rendering a subsequent payload-bearing reply.
        committedEdit.current=null;gesture.current=null;draftRef.current=null;
        setDraft(null);setPending(null);setLoaded(null);setRead({generation,data:null,error:null});
        setRecovery({state:"blocked",identity:null,canCancel:false});
        setMessage("الصورة ومعالمها محجوبة بالصلاحية الحالية. يمكن حسم الطلب المعلّق عبر سجل الاستعادة دون عرض المصدر.");
        const fresh=await bootstrapFacialRecovery({patientId,orthoCaseId},{current:valid,deny},controller.signal);
        if(!valid())return;
        if(fresh.actorId!==binding.actorId||canonicalJourneyJSON(fresh.scope)!==canonicalJourneyJSON(binding.scope)){deny();return;}
        if(fresh.recovery?.state==="blocked"||fresh.recovery?.state==="cancelled")setRecovery(fresh.recovery);
        if(fresh.recovery===null&&expectedRef.current)setRecoveryConflict(true);
        return;
      }
      if(!response.ok||response.redirected)throw Error("تعذّر التحقق من الصورة وسجلها؛ راجع ربطها بالحالة وصلاحية الملف.");
      const accepted=await readFacialRead(await response.json(),{patientId,orthoCaseId},documentId);
      if(!valid())return;
      if(accepted.actorId!==binding.actorId||accepted.clinicalCaseId!==binding.scope.clinicalCaseId){deny();return;}
      if((receipt?.state==="pending"||receipt?.state==="committed")&&canonicalJourneyJSON(accepted.image)!==canonicalJourneyJSON(receipt.expected.command.content.image))throw Error("أصل الصورة لا يطابق الطلب المستعاد؛ التحرير والحفظ متوقفان.");
      setRead({generation,data:accepted,error:null});
    }catch(e){if(valid())setRead({generation,data:null,error:e instanceof Error?e.message:"تعذّرت القراءة."});}finally{clearTimeout(timer);}})();
    return()=>{live=false;controller.abort();clearTimeout(timer);};
  },[generation,documentId,patientId,orthoCaseId,endpoint]);
  useEffect(()=>{if(!draft&&!pending)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);},[draft,pending]);
  const change=(next:FacialContent, reviewing=false, pointerId?:number)=>{
    if(!currentRender()||!editable||busyRef.current||!draft)return;
    const updated={...draft,content:reviewing?next:{...next,review:{state:"draft" as const,note:next.review.note}}};
    if(pointerId!==undefined&&gesture.current?.pointerId===pointerId)gesture.current.expectedDraft=updated;else gesture.current=null;
    committedEdit.current=null;setDraft(updated);
  };
  const changePoint=(key:FacialLandmark,x:number,y:number,pointerId?:number)=>{
    if(!currentRender()||!editable||!imageReady||!content||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return;
    change({...content,landmarks:{...content.landmarks,[key]:{state:"located",x,y}},review:{state:"draft",note:""}},false,pointerId);
  };
  const endPointer=(event:React.PointerEvent<SVGSVGElement>)=>{if(gesture.current?.pointerId===event.pointerId)gesture.current=null;};
  const pointer=(event:React.PointerEvent<SVGSVGElement>)=>{
    if(!currentRender()||!editable||!imageReady||!draft||!imageKey)return;
    if(event.type==="pointerdown"){
      if(event.button!==0||event.isPrimary===false||gesture.current)return;
      try{event.currentTarget.setPointerCapture(event.pointerId);}catch{return;}
      gesture.current={pointerId:event.pointerId,landmark:selected,imageKey,expectedDraft:draft};
    }else if(event.type!=="pointermove"||event.buttons!==1||gesture.current?.pointerId!==event.pointerId
      ||gesture.current.landmark!==selected||gesture.current.imageKey!==imageKey||gesture.current.expectedDraft!==draft
      ||!event.currentTarget.hasPointerCapture(event.pointerId))return;
    const bounds=event.currentTarget.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    changePoint(gesture.current!.landmark,(event.clientX-bounds.left)/bounds.width,(event.clientY-bounds.top)/bounds.height,event.pointerId);
  };
  function begin(){
    if(!currentRender()||!data?.canWrite||!image||documentId===null||draft||pending||busyRef.current||denied||!imageReady||recovery===undefined||recoveryBlocked||revision&&revision.id!==head?.id)return;
    const content=head?structuredClone(head.command.content):blankFacialContent(image);
    if(head&&canonicalJourneyJSON(content.image)!==canonicalJourneyJSON(image)){setMessage("أصل الصورة لا يطابق المراجعة المحفوظة؛ لا يمكن نقل معالمها إلى الأصل الحالي.");return;}
    content.review={state:"draft",note:""};committedEdit.current=null;setDraft({documentId,expectedHeadId:head?.id??null,reason:"",content});setMessage(null);
  }
  async function save(retry=false){
    if(!currentRender()||!data?.canWrite||!draft||denied||busyRef.current||!imageReady||recoveryBlocked||recovery===undefined||retry&&!pending||!retry&&(!editable||stale))return;
    let expected:FacialSaveExpectation;
    try{
      const command=retry?pending!:readFacialCommand({schemaVersion:1,clientRequestId:crypto.randomUUID(),documentId:draft.documentId,expectedHeadId:draft.expectedHeadId,reason:draft.reason,content:draft.content});
      expected=retry?expectedRef.current!:{scope:{patientId,orthoCaseId,clinicalCaseId:data.clinicalCaseId},actorId:data.actorId,previousVersion:head?.version??0,command};
      if(!expected||canonicalJourneyJSON(expected.command)!==canonicalJourneyJSON(command))throw Error("identity_changed");
    }catch{setMessage("أكمل سبب المراجعة ومصدر تاريخ الصورة. مراجعة الطبيب تتطلب فحص الجودة ونتيجة قابلة للحساب وملاحظة مكتوبة.");return;}
    publishExpected(expected);setPending(expected.command);setBusy(true);busyRef.current=true;setUncertain(false);setMessage(null);committedEdit.current=null;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    const context={scope:expected.scope,actorId:expected.actorId,current,deny};
    try{
      const identity=recovery?.state==="pending"||recovery?.state==="committed"?recovery.identity:undefined;
      await submitFacialAndAcknowledge(context,expected,identity,controller.signal);
      if(!current())return;
      publishExpected(null);setDraft(null);setPending(null);setRecovery(undefined);setHistoryId(null);setMessage("حُفظت مراجعة الصورة وتأكد تسجيلها على الخادم.");setRefresh(v=>v+1);
    }catch{if(current()){setUncertain(true);setMessage("لم يتأكد الحفظ والإقرار النهائي. احتُفظ بمعرّف الطلب نفسه؛ تحقّق من الاستعادة على الخادم قبل إنشاء أي طلب بديل.");}}
    finally{clearTimeout(timer);busyRef.current=false;if(current())setBusy(false);}
  }
  async function cancelRecovery(){
    if(!currentRender()||busyRef.current||!scopeRef.current||recovery===undefined)return;
    const receipt=recovery,expected=expectedRef.current;
    if(!expected&&(receipt?.state==="committed"||receipt?.state==="blocked"&&!receipt.canCancel||!receipt))return;
    if(!window.confirm("إلغاء طلب القياسات المعلّق والتخلص من مسودته؟ لا يحذف ذلك أي مراجعة سريرية حُفظت بالفعل."))return;
    const binding=scopeRef.current;busyRef.current=true;setBusy(true);committedEdit.current=null;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const identity=expected?await facialCommandIdentity(expected.command):receipt?.identity;
      if(!identity||!current())return;
      const alreadyCancelled=receipt?.state==="cancelled"&&receipt.identity.commandId===identity.commandId&&receipt.identity.requestFingerprint===identity.requestFingerprint;
      await cancelFacialAndAcknowledge({...binding,current,deny},identity,alreadyCancelled,controller.signal);
      if(!current())return;
      publishExpected(null);setDraft(null);setPending(null);setRecovery(undefined);setRecoveryConflict(false);setUncertain(false);setLoaded(null);setDocumentId(null);setRefresh(v=>v+1);setMessage("أُلغي الطلب المعلّق وأُقرّ إلغاؤه؛ لم تُحذف أي مراجعة محفوظة.");
    }catch{if(current())setMessage("لم يتأكد إلغاء الطلب. أعد التحقق من حالة الاستعادة؛ لا تنشئ طلباً بديلاً.");}
    finally{clearTimeout(timer);busyRef.current=false;if(current())setBusy(false);}
  }
  function discardLocalAndRestore(){
    if(!currentRender()||busyRef.current||expectedRef.current||!draftRef.current||!recoveryConflict||!recovery||(recovery.state!=="pending"&&recovery.state!=="committed"))return;
    if(!window.confirm("تجاهل المسودة المحلية غير المرسلة واستعادة طلب الحفظ المسجّل في النافذة الأخرى؟"))return;
    if(!currentRender()||busyRef.current||expectedRef.current)return;
    const restored=recovery.expected;committedEdit.current=null;gesture.current=null;publishExpected(restored);
    const next={documentId:restored.command.documentId,expectedHeadId:restored.command.expectedHeadId,reason:restored.command.reason,content:restored.command.content};
    draftRef.current=next;setDraft(next);setPending(restored.command);setRecoveryConflict(false);setUncertain(true);setLoaded(null);setDocumentId(restored.command.documentId);setRefresh(v=>v+1);
  }
  const recoveryControls=<section aria-label="استعادة طلب قياسات الوجه" className="space-y-2 rounded-lg border p-3">
    <p>طلبات الحفظ التي وصلت إلى سجل الخادم تُستعاد بعد إغلاق الصفحة. الطلب الذي لم يصل إلى الخادم لا يمكن استعادته بعد الإغلاق. المسودات التي لم يُضغط حفظها تبقى في هذه الصفحة فقط؛ لا تُخزّن القياسات في تخزين المتصفح.</p>
    {recoveryConflict&&!hasExpected&&!!draft&&(recovery?.state==="pending"||recovery?.state==="committed")&&<button className={control} disabled={busy} onClick={discardLocalAndRestore}>تجاهل المسودة المحلية واستعادة طلب الخادم</button>}
    {(!!pending||recoveryBlocked||!!error)&&<button className={control} disabled={busy} onClick={()=>{if(currentRender()&&!busyRef.current){committedEdit.current=null;setRefresh(v=>v+1);}}}>التحقق من استعادة طلب القياسات</button>}
    {(recovery?.state==="pending"||recovery?.state==="cancelled"||recovery?.state==="blocked"&&recovery.canCancel||recovery===null&&!!pending||recoveryConflict&&hasExpected)&&<button className={control} disabled={busy} onClick={()=>void cancelRecovery()}>إلغاء طلب القياسات المعلّق</button>}
  </section>;
  if(denied)return <p role="alert" className="rounded-xl border p-4">الصورة والتحليل محجوبان بالصلاحية الحالية. أعد تسجيل الدخول للتحقق.</p>;
  if(recoveryBlocked)return <main dir="rtl" className="space-y-3 p-4"><p role="alert">تعذّر إتاحة مصدر الطلب المستعاد أو تعارض مع طلب هذه النافذة. لا تُعرض الصورة أو معالمها حتى حسم حالة الطلب.</p>{message&&<p role="status">{message}</p>}{recoveryControls}</main>;
  return <main dir="rtl" className="mx-auto max-w-7xl space-y-4 p-3" data-testid="ortho-facial-workspace">
    <header className="space-y-2"><a className="inline-flex min-h-11 items-center underline" href={clinicalContextHref(patientId,{orthoCaseId,pillar:"diagnostics"},"ortho")}>العودة إلى ملف حالة التقويم #{orthoCaseId}</a>
      <h1 className="text-xl font-bold">قياسات صورة الوجه</h1><p className="text-sm">حدد المعالم يدوياً على صورة أمامية في الراحة. النتائج نسب وإسقاطات ثنائية الأبعاد؛ تفسيرها للطبيب، ولا تتحول إلى تشخيص أو خطة تلقائياً.</p>
      <p className="text-xs text-slate-600">تصحيح المحور يعالج الميل داخل مستوى الصورة فقط؛ لا يصحح دوران الرأس الجانبي أو رفعه وخفضه أو تشوه المنظور والعدسة. كل جزء يجب أن يمتد بكسلاً واحداً على الأقل حتى يحسب، لذلك قد تتغير إتاحة النتيجة مع دقة الصورة. النتائج الجزئية لا تعني مراجعة المعالم غير المتاحة.</p>
      <p className="text-xs text-slate-600">الأخماس هنا تستخدم حدود الأذن Postaurale. لا تُخلط بحدود الوجنة. اليمين واليسار المذكوران هما جهتا الصورة، ولا يحددان جهة المريض في صورة معكوسة.</p></header>
    {recoveryControls}
    {error&&<p role="alert">{error}</p>}{message&&<p role="status" className="rounded-lg border bg-amber-50 p-3">{message}</p>}
    <div className="flex flex-wrap gap-2"><label className="min-w-0 flex-1">الصورة المرتبطة بالحالة<select aria-label="الصورة المرتبطة بالحالة" className={`${control} block w-full`} value={documentId??""} disabled={!data||busy||!!pending||recovery===undefined} onChange={e=>{
      if(!currentRender()||busyRef.current||pending||recovery===undefined)return;if(draft&&!window.confirm("تجاهل مسودة القياسات غير المحفوظة لهذه الصورة؟"))return;
      setDraft(null);setHistoryId(null);setMessage(null);setLoaded(null);setDocumentId(e.target.value?Number(e.target.value):null);
    }}><option value="">اختر صورة…</option>{data?.documents.map(d=><option key={d.id} value={d.id}>{d.title} · {d.takenOn??"تاريخ الصورة غير مسجل"}</option>)}</select></label>
    <button className={control} disabled={busy||!!pending} onClick={()=>{if(currentRender()&&!busyRef.current&&!pending)setRefresh(v=>v+1);}}>تحديث سجل الصور والقياسات</button></div>
    {!data&&!error&&<p role="status">جارٍ التحقق من مصادر الحالة…</p>}
    {data?.documentsTruncated&&<p>تعرض القائمة أحدث 100 صورة؛ قد توجد صور أقدم خارج القائمة.</p>}
    {data&&data.documents.length===0&&<p>لا توجد صورة متاحة مرتبطة بهذه الحالة. أضف الصورة من قسم الصور والأشعة في ملف الحالة.</p>}
    {data&&documentId&&image&&<>
      <div className="flex flex-wrap gap-2">{data.history.length>0&&<label>المراجعة المحفوظة<select aria-label="المراجعة المحفوظة" className={`${control} block`} value={revision?.id??""} disabled={!!draft||!!pending||busy} onChange={e=>{if(currentRender()&&!draft&&!pending&&!busyRef.current)setHistoryId(Number(e.target.value));}}>
        {data.history.map(r=><option key={r.id} value={r.id}>نسخة {r.version} · {r.createdAt.slice(0,10)} · {r.createdBy}</option>)}</select></label>}
        {!draft&&<button className={control} disabled={!data.canWrite||!imageReady||!!pending||recovery===undefined||!!revision&&revision.id!==head?.id} onClick={begin}>{head?"فتح مراجعة جديدة من آخر نسخة":"بدء قياسات هذه الصورة"}</button>}
        {data.historyTruncated&&<p>تظهر أحدث 30 مراجعة لهذه الصورة؛ لا يعني ذلك حذف المراجعات الأقدم.</p>}</div>
      {data.historyTruncated&&data.history.length>0&&<OrthoFacialOlderHistory data={data} readIdentity={generation} active={current} onDenied={deny}/>}
      {stale&&<p role="alert">تغيرت آخر مراجعة؛ بقيت مسودتك مرتبطة بنسختها السابقة. راجع السجل ثم تجاهل المسودة صراحةً لفتح مراجعة جديدة.</p>}
      <p className="text-sm font-bold">{draft?"مسودة قياسات غير محفوظة":revision?`نسخة ${revision.version} محفوظة — ${revision.command.content.review.state==="reviewed"?"راجعها الطبيب":"بانتظار مراجعة الطبيب"}`:"لم تحفظ قياسات لهذه الصورة بعد"}</p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <div className="min-w-0 space-y-3">
          <div dir="ltr" className="relative w-full overflow-hidden rounded-xl border bg-slate-900" style={{aspectRatio:`${image.width} / ${image.height}`}}>
            <img key={imageKey} src={`/api/ortho/${orthoCaseId}/facial-image?patientId=${patientId}&documentId=${documentId}&sha256=${image.sha256}`} alt="أصل صورة الوجه باتجاه العرض المتحقق" className="h-full w-full object-contain"
              onLoad={event=>{if(!currentRender())return;const img=event.currentTarget;if(img.naturalWidth===image.width&&img.naturalHeight===image.height)setLoaded(imageKey);else{setLoaded(null);setMessage("أبعاد الصورة المعروضة لا تطابق مصدر المعالم؛ التحرير متوقف.");}}}
              onError={()=>{if(currentRender()){setLoaded(null);setMessage("تعذر عرض أصل الصورة؛ لا يمكن تحديد المعالم أو الحفظ حتى التحقق منه.");}}}/>
            <svg aria-label="لوحة معالم الوجه" viewBox={`0 0 ${image.width} ${image.height}`} className="absolute inset-0 h-full w-full touch-none" onPointerDown={pointer} onPointerMove={pointer} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
              {content&&Object.entries(content.landmarks).map(([key,p])=>p.state==="located"?<g key={key} pointerEvents="none"><circle cx={p.x*image.width} cy={p.y*image.height} r={Math.max(image.width/120,3)} fill={key===selected?"#fbbf24":"#22d3ee"} stroke="#111827" strokeWidth={Math.max(image.width/400,1)}/><text x={p.x*image.width+image.width/80} y={p.y*image.height} fill="white" stroke="#111827" strokeWidth={image.width/1500} fontSize={image.width/35}>{FACIAL_LANDMARKS.find(l=>l[0]===key)?.[1].split(" — ")[0]}</text></g>:null)}
              {content&&([['tr','gl','sn','sto','me'],['paImageLeft','exImageLeft','enImageLeft','enImageRight','exImageRight','paImageRight']] as FacialLandmark[][]).flatMap((group,groupIndex)=>group.map(key=>{
                const p=content.landmarks[key],a=content.landmarks.axisTop,b=content.landmarks.axisBottom;if(p?.state!=="located"||a?.state!=="located"||b?.state!=="located")return null;
                const dx=(b.x-a.x)*image.width,dy=(b.y-a.y)*image.height,len=Math.hypot(dx,dy);if(len<1)return null;
                const vx=groupIndex===0?dy/len:dx/len,vy=groupIndex===0?-dx/len:dy/len,span=Math.hypot(image.width,image.height);
                return <line key={key} x1={p.x*image.width-vx*span} y1={p.y*image.height-vy*span} x2={p.x*image.width+vx*span} y2={p.y*image.height+vy*span} stroke={groupIndex===0?"#fbbf24":"#67e8f9"} strokeWidth={Math.max(image.width/600,1)} strokeDasharray="8 5" pointerEvents="none"/>;
              }))}
            </svg>
          </div>
          {draft&&<><p className="text-sm">اختر المعلم ثم انقر أو اسحب على الصورة لتحديده وتصحيحه. الإحداثيات أدناه بالبكسل من الصورة الموجهة، وليست بالملليمتر.</p>
            <label className="block">المعلم الحالي<select aria-label="المعلم الحالي" className={`${control} block w-full`} value={selected} disabled={!editable} onChange={e=>{if(currentRender()&&editable){gesture.current=null;setSelected(e.target.value as FacialLandmark);setUnavailableReason("");}}}>{FACIAL_LANDMARKS.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
            <p className="text-sm">{FACIAL_LANDMARKS.find(row=>row[0]===selected)?.[2]}</p>
            <PixelEditor key={`${selected}:${JSON.stringify(content?.landmarks[selected])}`} point={content?.landmarks[selected]} width={image.width} height={image.height} disabled={!editable||!imageReady} apply={(x,y)=>changePoint(selected,x/image.width,y/image.height)}/>

            <label className="block">سبب تعذر تحديد المعلم<input className={`${control} block w-full`} value={unavailableReason} disabled={!editable} onChange={e=>{if(currentRender()&&editable)setUnavailableReason(e.target.value);}} maxLength={500}/></label>
            <button className={control} disabled={!editable||!unavailableReason.trim()} onClick={()=>{if(content&&editable&&unavailableReason.trim())change({...content,landmarks:{...content.landmarks,[selected]:{state:"unavailable",reason:unavailableReason}},review:{state:"draft",note:""}});}}>تسجيل المعلم غير متاح</button>
          </>}
        </div>
        <div className="min-w-0 space-y-3">{content&&<Results results={draft?computeFacialResults(content):revision!.results}/>}
          {draft&&content&&<section aria-label="مصدر الصورة ومراجعة الطبيب" className="space-y-3 rounded-lg border p-3">
            <label className="block">مصدر تاريخ الصورة<select aria-label="مصدر تاريخ الصورة" className={`${control} block w-full`} value={content.occurrence.dateProvenance} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,dateProvenance:e.target.value as FacialContent["occurrence"]["dateProvenance"],occurredOn:null}})}>
              <option value="unknown">غير معلوم</option><option value="contemporaneous_record">موثق وقت التصوير</option><option value="retrospective_record">توثيق لاحق</option><option value="historical_source">مصدر تاريخي</option></select></label>
            {content.occurrence.dateProvenance!=="unknown"&&<label className="block">تاريخ التقاط الصورة<input className={`${control} block w-full`} type="date" value={content.occurrence.occurredOn??""} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,occurredOn:e.target.value||null}})}/></label>}
            <label className="block">توضيح مصدر التاريخ<input className={`${control} block w-full`} maxLength={1000} value={content.occurrence.sourceNote} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,sourceNote:e.target.value}})}/></label>
            <fieldset><legend className="font-bold">مراجعة جودة الصورة</legend>{([["frontalRest","الصورة أمامية وفي وضع الراحة"],["headPosition","راجعت وضع الرأس والميل والدوران"],["visibleLandmarks","المعالم المستخدمة ظاهرة بوضوح"],["perspectiveReviewed","راجعت المنظور والمسافة والعدسة وحدود المقارنة"]] as const).map(([key,label])=><label key={key} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!editable} checked={content.quality[key]} onChange={e=>change({...content,quality:{...content.quality,[key]:e.target.checked},review:{state:"draft",note:""}})}/>{label}</label>)}</fieldset>
            <label className="block">حدود الصورة أو المعالم<textarea className={`${control} block w-full`} maxLength={1000} disabled={!editable} value={content.quality.note} onChange={e=>change({...content,quality:{...content.quality,note:e.target.value},review:{state:"draft",note:""}})}/></label>
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={!editable} checked={content.review.state==="reviewed"} onChange={e=>change({...content,review:{...content.review,state:e.target.checked?"reviewed":"draft"}},true)}/>راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب</label>
            <label className="block">تفسير الطبيب وملاحظة المراجعة<textarea className={`${control} block w-full`} maxLength={2000} disabled={!editable} value={content.review.note} onChange={e=>change({...content,review:{...content.review,note:e.target.value}},true)}/></label>
            <label className="block">سبب حفظ هذه المراجعة<input className={`${control} block w-full`} maxLength={500} disabled={!editable} value={draft.reason} onChange={e=>{if(currentRender()&&editable&&!busyRef.current){committedEdit.current=null;setDraft({...draft,reason:e.target.value});}}}/></label>
            <div className="flex flex-wrap gap-2"><button className={control} disabled={!editable||!imageReady} onClick={()=>void save()}>حفظ مراجعة قياسات الصورة</button>
              <button className={control} disabled={busy||!!pending} onClick={()=>{if(currentRender()&&!busyRef.current&&!pending&&window.confirm("تجاهل مسودة قياسات الصورة غير المحفوظة؟")){setDraft(null);setMessage(null);}}}>تجاهل مسودة الصورة</button></div>
          </section>}
          {!draft&&revision&&<section className="space-y-2 rounded-lg border p-3"><p>المصدر: صورة #{revision.documentId} · {revision.command.content.occurrence.occurredOn??"تاريخ الصورة غير معلوم"}</p><p>{revision.command.content.occurrence.sourceNote}</p><p>حفظها {revision.createdBy} · {revision.createdAt}</p><p>{revision.command.reason}</p><ul className="text-sm">{([["frontalRest","صورة أمامية في الراحة"],["headPosition","وضع الرأس"],["visibleLandmarks","وضوح المعالم"],["perspectiveReviewed","المنظور والمسافة"]] as const).map(([key,label])=><li key={key}>{label}: {revision.command.content.quality[key]?"أكده الطبيب":"لم يؤكد"}</li>)}</ul><p>{revision.command.content.quality.note}</p><p>{revision.command.content.review.note}</p><dl className="space-y-1 text-sm">{FACIAL_LANDMARKS.map(([key,label])=>{const p=revision.command.content.landmarks[key];return <div key={key}><dt className="font-bold">{label}</dt><dd>{p?.state==="located"?`${(p.x*image.width).toFixed(1)}, ${(p.y*image.height).toFixed(1)} px`:p?.state==="unavailable"?`غير متاح: ${p.reason}`:"لم يحدد"}</dd></div>;})}</dl><p className="break-all text-xs">بصمة المراجعة: {revision.contentHash}</p></section>}
          {uncertain&&pending&&<div role="alert"><button className={control} disabled={busy||!data||!imageReady} onClick={()=>void save(true)}>التحقق بإعادة نفس طلب قياسات الصورة</button></div>}
        </div>
      </div>
    </>}
  </main>;
}

/** Both coordinates must be explicitly supplied; an omitted axis never becomes a guessed landmark. */
function PixelEditor({point,width,height,disabled,apply}:{point:FacialContent["landmarks"][FacialLandmark];width:number;height:number;disabled:boolean;apply:(x:number,y:number)=>void}){
  const px=point?.state==="located"?String(Number((point.x*width).toFixed(3))):"",py=point?.state==="located"?String(Number((point.y*height).toFixed(3))):"";
  const [x,setX]=useState(px),[y,setY]=useState(py);
  const valid=x.trim()!==""&&y.trim()!==""&&Number.isFinite(Number(x))&&Number.isFinite(Number(y))&&Number(x)>=0&&Number(x)<=width&&Number(y)>=0&&Number(y)<=height;
  return <div className="space-y-2"><div className="grid grid-cols-2 gap-2">{(["X","Y"] as const).map(axis=><label key={axis}>إحداثي {axis} بالبكسل<input aria-label={`إحداثي ${axis} بالبكسل`} className={`${control} w-full`} type="number" step="0.1" min="0" max={axis==="X"?width:height} disabled={disabled} value={axis==="X"?x:y} onChange={e=>(axis==="X"?setX:setY)(e.target.value)}/></label>)}</div><button className={control} disabled={disabled||!valid} onClick={()=>{if(!disabled&&valid)apply(Number(x),Number(y));}}>تطبيق الإحداثيين على المعلم</button></div>;
}
