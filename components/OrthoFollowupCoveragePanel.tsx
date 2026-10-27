"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { parseFollowupCoverageCommand, type FollowupCoverageRead } from "@/lib/ortho-followup-coverage";

import { MONEY_JOURNAL_EVENT } from "./useDurableMoneyAttempt";
import { acknowledgeFinancialCommand, readFinancialJournal, readFinancialJournalsForActor, reserveFinancialCommand, type FinancialJournal } from "@/lib/financial-command-journal";
import { followupCoverageJournal, restoreFollowupCoverage, readFollowupCoverageReceipt, isFollowupCoverageRejection, type FollowupCoverageAttempt } from "@/lib/ortho-followup-coverage-recovery";

const UNKNOWN = "لم تُحسم نتيجة الحفظ. الطلب محفوظ؛ تحقّق من حالته أو أعد الطلب نفسه، ولا تنشئ قرارًا جديدًا.";
const announce = () => window.dispatchEvent(new Event(MONEY_JOURNAL_EVENT));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
type Props={patientId:number;orthoCaseId:number;onSaved:()=>void};
/** This standalone current-version action is administrator-only. The canonical
 * owner version must substitute its central agreement grant, never role hints. */
export function OrthoFollowupCoveragePanel(props:Props){
  const session=useSession();
  if(!session||session.role!=="admin")return null;
  const owner=JSON.stringify([props.patientId,props.orthoCaseId,session.username,session.role,session.permissions??null]);
  return <CoverageEditor key={owner} {...props} actor={session.username} />;
}
function CoverageEditor({patientId,orthoCaseId,onSaved,actor}:Props & {actor:string}){
  const [open,setOpen]=useState(false),[read,setRead]=useState<FollowupCoverageRead|null>(null);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [selected,setSelected]=useState(""),[decision,setDecision]=useState<""|"included"|"excluded">("");
  const [reason,setReason]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false);
  const [journal,setJournal]=useState<FinancialJournal|null>(null),[journalError,setJournalError]=useState<string|null>(null);
  const lifetime=useRef(0),journalRead=useRef(0),loading=useRef<AbortController|null>(null),writing=useRef<AbortController|null>(null),sending=useRef(false);
  const [recoveries,setRecoveries]=useState<FollowupCoverageAttempt[]>([]),[selectedRecovery,setSelectedRecovery]=useState<string|null>(null);
  const pending=recoveries.find(attempt=>followupCoverageJournal(attempt).original===selectedRecovery)??null;
  const otherPending=!!journal?.command&&(!pending||journal.command.original!==followupCoverageJournal(pending).original);
  const recoveryBlocked=recoveries.length>0;
  const url=`/api/ortho/${orthoCaseId}/followup-coverage?patientId=${patientId}`;
  useEffect(()=>{const owner=++lifetime.current;return()=>{lifetime.current=owner+1;loading.current?.abort();writing.current?.abort();};},[]);
  const syncJournal=useCallback(async()=>{
    const owner=lifetime.current,sequence=++journalRead.current;
    try{
      const [saved,scopes]=await Promise.all([readFinancialJournal({actor,patientId}),readFinancialJournalsForActor(actor)]);
      if(owner!==lifetime.current||sequence!==journalRead.current)return;
      setJournal(saved);setJournalError(null);
      const found=scopes.flatMap(({scope,journal:historical})=>{
        const attempt=historical.command&&restoreFollowupCoverage(historical.command,actor,scope.patientId);
        return attempt?.orthoCaseId===orthoCaseId?[attempt]:[];
      });
      setRecoveries(found);
      setSelectedRecovery(previous=>found.length===1?followupCoverageJournal(found[0]).original:found.some(a=>followupCoverageJournal(a).original===previous)?previous:null);
      if(found.length){setOpen(true);if(found.length===1)setReason(found[0].command.reason);}
    }catch{if(owner===lifetime.current&&sequence===journalRead.current){setJournal(null);setJournalError("تعذّر قراءة الطلب المالي المحفوظ؛ لم يُرسل طلب جديد. لا تمسح بيانات المتصفح.");}}
  },[actor,patientId,orthoCaseId]);
  useEffect(()=>{
    void syncJournal();const sync=()=>{void syncJournal();};
    window.addEventListener(MONEY_JOURNAL_EVENT,sync);window.addEventListener("focus",sync);
    return()=>{window.removeEventListener(MONEY_JOURNAL_EVENT,sync);window.removeEventListener("focus",sync);};
  },[syncJournal]);
  const load=useCallback(async()=>{
    loading.current?.abort();const controller=new AbortController();loading.current=controller;
    const owner=lifetime.current,timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(url,{cache:"no-store",redirect:"manual",signal:controller.signal});
      const payload=await response.json();
      if(owner!==lifetime.current||controller.signal.aborted)return;
      if(response.redirected||!response.ok){setRead(null);setError(payload.message??"تعذّر قراءة نطاق المتابعات.");return;}
      if(payload.patientId!==patientId||payload.orthoCaseId!==orthoCaseId||!Array.isArray(payload.sources)||typeof payload.enabled!=="boolean"||typeof payload.canEdit!=="boolean")throw new Error("Invalid coverage context");
      setRead(payload);setSelected("");setDecision("");setConfirmed(false);
    }catch{if(owner===lifetime.current&&loading.current===controller){setRead(null);setError("تعذّر التحقق من نطاق المتابعات؛ لا تفترض أنه مشمول أو خارج الاتفاق.");}}
    finally{clearTimeout(timeout);}
  },[url,patientId,orthoCaseId]);
  useEffect(()=>{if(open)void load();return()=>loading.current?.abort();},[open,load]);
  useEffect(()=>{
    if(!recoveryBlocked)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  },[recoveryBlocked]);
  const source=read?.sources.find(s=>`${s.invoiceId}:${s.planItemId}`===selected);
  async function send(mode:"submit"|"status",fresh?:FollowupCoverageAttempt){
    if(sending.current||!journal||journalError||(!pending&&(otherPending||recoveryBlocked))||(pending&&otherPending&&mode==="submit"))return;
    const attempt=pending??fresh;if(!attempt)return;
    const owner=lifetime.current,current=()=>owner===lifetime.current;
    sending.current=true;setBusy(true);setError(null);setNotice(null);
    let sent=!!pending;
    try{
      const durable=followupCoverageJournal(attempt);
      // The shared actor/patient transaction arbitrates all money workflows and tabs.
      const originalScope={actor,patientId:attempt.patientId};
      const before=pending?await readFinancialJournal(originalScope):journal;
      if(!current())return;
      if(pending&&before.command?.original!==durable.original){await syncJournal();if(current())setError("تغيّر الطلب المحفوظ في نافذة أخرى؛ تحقّق من العرض المحدّث.");return;}
      const saved=await reserveFinancialCommand(originalScope,before.revision,durable);
      if(!current())return;
      ++journalRead.current;
      if(attempt.patientId===patientId)setJournal(saved);
      if(saved.command?.original===durable.original){setRecoveries(previous=>previous.some(a=>followupCoverageJournal(a).original===durable.original)?previous:[...previous,attempt]);setSelectedRecovery(durable.original);}
      announce();
      if(saved.command?.kind!==durable.kind||saved.command.key!==durable.key||saved.command.original!==durable.original){
        setError("توجد عملية مالية أخرى محفوظة لهذا المريض؛ استكملها أولًا من الحساب.");return;
      }
      const controller=new AbortController();writing.current=controller;
      const timeout=setTimeout(()=>controller.abort(),20000);
      let response:Response,result:unknown;
      try{
        sent=true;
        response=await fetch(`/api/ortho/${attempt.orthoCaseId}/followup-coverage?patientId=${attempt.patientId}`,{method:mode==="status"?"PUT":"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(attempt.command),redirect:"manual",cache:"no-store",signal:controller.signal});
        result=await response.json();
      }finally{clearTimeout(timeout);}
      if(!current()||controller.signal.aborted)return;
      const receipt=!response.redirected&&response.ok&&(mode!=="status"||response.status===200)&&record(result)
        ?readFollowupCoverageReceipt(mode==="status"&&result.state==="committed"?result.revision:mode==="submit"&&result.ok===true?result.revision:null,attempt):null;
      const rejected=!response.redirected&&response.status===200&&mode==="status"&&isFollowupCoverageRejection(result,attempt);
      if(receipt||rejected){
        await acknowledgeFinancialCommand(originalScope,durable);
        if(!current())return;
        ++journalRead.current;announce();await syncJournal();
        if(!current())return;
        setNotice(receipt?"سُجل نطاق المتابعات القادمة مع المصدر والسبب. الزيارات الموقعة سابقًا لم تتغير.":"ثبت رفض الطلب الأصلي دون حفظ. يمكنك مراجعة المصدر وتأكيد قرار جديد صراحةً.");
        await load();
        if(receipt&&current())onSaved();
      }else setError(response.status===401||response.status===403?"تغيّرت الجلسة أو الصلاحية. الطلب محفوظ؛ عُد بالحساب المصرّح له للتحقق من نتيجته.":UNKNOWN);
    }catch{if(current()){setError(sent?UNKNOWN:"تعذّر تثبيت الطلب أو تغيّر من شاشة أخرى. لم يُرسل طلب جديد؛ راجع العملية المحفوظة.");await syncJournal();}}
    finally{sending.current=false;if(current())setBusy(false);}
  }
  function save(){
    if(!read?.canEdit||!source||!decision||!confirmed||recoveryBlocked||busy||!journal||journalError||otherPending)return;
    const {fingerprint,invoiceNumber:_n,serviceName:_s,...identity}=source;
    const command=parseFollowupCoverageCommand({schemaVersion:1,commandId:crypto.randomUUID(),expectedRevisionId:read.current?.id??null,
      source:identity,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision,reason});
    if(!command){setError("اختر المصدر والنطاق وأدخل سببًا من 3 إلى 600 حرف.");return;}
    void send("submit",{actor,patientId,orthoCaseId,command});
  }
  return <section className="mt-2 rounded-xl border border-navy-200 bg-navy-50/40 p-3" aria-label="نطاق المتابعات الروتينية للتقويم">
    <button type="button" className="min-h-11 text-sm font-bold text-navy-900" disabled={busy||recoveryBlocked}
      onClick={()=>setOpen(value=>!value)}>نطاق المتابعات الروتينية ضمن الاتفاق {open?"−":"+"}</button>
    {open?<div className="space-y-2 text-xs text-slate-700">
      <p>وجود فاتورة لا يحدد وحده شمول الشدّات. هذا القرار يخص المتابعات الروتينية القادمة للحالة فقط؛ لا يغيّر قيمة الاتفاق أو التحصيل، ولا يشمل الخدمات الإضافية أو يعيد تصنيف زيارة موقعة. عدم وجود رسم شدّة إضافي لا يعني سداد رصيد الاتفاق أو خلو الحساب من المديونية.</p>
      {journalError?<p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-800">{journalError}</p>:null}
      {otherPending?<p role="alert" className="rounded-lg bg-amber-50 p-2 text-amber-900">توجد عملية مالية أخرى محفوظة لهذا المريض؛ استكملها من الحساب قبل اعتماد نطاق جديد.</p>:null}
      {error?<p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-800">{error}</p>:null}
      {notice?<p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">{notice}</p>:null}
      {!read&&!error?<p role="status">جارٍ التحقق من المصدر ونطاق المتابعات…</p>:null}
      {read?<>
        <p>{read.current?`${read.current.decision==="included"?"آخر قرار: مشمولة":"آخر قرار: غير مشمولة"} · المراجعة ${read.current.version} · ${read.current.createdBy}`:"لم يُسجل نطاق صريح للمتابعات بعد."}</p>
        {read.current&&!read.applicable?<p role="alert" className="text-amber-900">مصدر القرار السابق تغيّر أو يحتاج مراجعة؛ لا تُعدّ المتابعات مشمولة تلقائيًا.</p>:null}
        {!read.enabled?<p>الميزة لم تُفعّل في قاعدة البيانات بعد؛ لا تنشئ اتفاق أقساط أو فاتورة بديلة.</p>:!read.canEdit?<p>الحالة مغلقة. السجل للقراءة، ولا يتغير نطاق متابعات جديدة.</p>:null}
        {read.enabled&&read.canEdit?<fieldset disabled={busy||recoveryBlocked||otherPending||!journal||!!journalError} className="space-y-2">
          <label className="block">مصدر الاتفاق المثبت لهذه الحالة
            <select aria-label="مصدر تغطية المتابعات" value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false);}} className="mt-1 min-h-11 w-full rounded-lg border bg-white p-2">
              <option value="">اختر الفاتورة والبند صراحةً</option>
              {read.sources.map(s=><option key={`${s.invoiceId}:${s.planItemId}`} value={`${s.invoiceId}:${s.planItemId}`}>{s.invoiceNumber} · خطة {s.planId} · بند {s.planItemId} · {s.serviceName}</option>)}
            </select>
          </label>
          {!read.sources.length?<p>لا يوجد مصدر فاتورة حالي مثبت لنفس المريض والحالة والبند. راجع الربط أو التصحيح في الحساب، ولا تنشئ دينًا مكررًا.</p>:null}
          <label className="block">ما اتُّفق عليه للمتابعات الروتينية
            <select aria-label="قرار نطاق المتابعات" value={decision} onChange={e=>{setDecision(e.target.value as typeof decision);setConfirmed(false);}} className="mt-1 min-h-11 w-full rounded-lg border bg-white p-2">
              <option value="">اختر نطاقًا صريحًا</option><option value="included">مشمولة ضمن الاتفاق المحدد — بلا رسم شدّة إضافي</option><option value="excluded">غير مشمولة — كل شدّة تحتاج قرار فوترة مستقلًا</option>
            </select>
          </label>
          <label className="block">سبب الاعتماد أو مرجع الاتفاق مع المريض
            <textarea aria-label="سبب اعتماد نطاق المتابعات" value={reason} maxLength={600} onChange={e=>setReason(e.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2" />
          </label>
          <label className="flex min-h-11 items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} className="mt-1" />أؤكد أن هذا هو نطاق المتابعات الروتينية المتفق عليه لهذه الحالة والمصدر المحدد، وليس إعفاءً عامًا للخدمات الإضافية.</label>
          <button type="button" onClick={save} disabled={busy||recoveryBlocked||otherPending||!journal||!!journalError||!source||!decision||!confirmed||reason.trim().length<3} className="min-h-11 rounded-lg bg-navy-900 px-4 py-2 font-bold text-white disabled:opacity-40">اعتماد نطاق المتابعات القادمة</button>
        </fieldset>:null}
      </>:null}
      {recoveries.length>1?<div className="space-y-2 rounded-lg border border-amber-300 p-2">
        <p>توجد عدة طلبات محفوظة لهذه الحالة. اختر طلبًا للتحقق منه وحده؛ لن يُحذف أو يُعاد ربط أي طلب تلقائيًا.</p>
        {recoveries.map(attempt=><button type="button" key={followupCoverageJournal(attempt).original} disabled={busy}
          aria-pressed={selectedRecovery===followupCoverageJournal(attempt).original}
          className="min-h-11 rounded-lg border px-3 py-2"
          onClick={()=>{setSelectedRecovery(followupCoverageJournal(attempt).original);setReason(attempt.command.reason);}}>
          تحقق من طلب الملف الأصلي {attempt.patientId} · {attempt.command.commandId}
        </button>)}
      </div>:null}
      {pending?<div className="flex flex-wrap gap-2">
        <p className="w-full text-amber-900">طلب نطاق محفوظ لهذه الحالة؛ لن يتغيّر مصدره أو قراره عند إعادة المحاولة. الملف الأصلي: {pending.patientId} · الحالة: {pending.orthoCaseId}. {pending.patientId!==patientId?"استُعيد الطلب من نطاق الملف السابق؛ سيُتحقق منه بعنوانه وجسمه الأصليين دون نقله إلى هذا الملف.":""}</p>
        <button type="button" disabled={busy||!!journalError} onClick={()=>void send("status")} className="min-h-11 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 font-bold">تحقق من نتيجة الطلب نفسه</button>
        <button type="button" disabled={busy||!!journalError||otherPending} onClick={()=>void send("submit")} className="min-h-11 rounded-lg border border-amber-400 px-3 py-2 font-bold">إعادة الطلب المحفوظ نفسه</button>
      </div>:null}
      {!recoveryBlocked&&!busy?<button type="button" onClick={()=>{setError(null);void load();}} className="min-h-11 px-2 underline">إعادة تحميل المصدر والسجل</button>:null}
    </div>:null}
  </section>;
}
