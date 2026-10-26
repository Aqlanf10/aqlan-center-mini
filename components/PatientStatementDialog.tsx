"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canViewMoney } from "@/lib/roles";
import { financeAccessFor } from "@/lib/finance-permissions";
import { PATIENT_STATEMENT_TYPES, type PatientStatementDocument as StatementDocument, type PatientStatementType } from "@/lib/patient-statement-document";
import { createStatementFiles, downloadStatementFile, statementRecipient, statementWhatsAppUrl, supportsStatementFileShare, type StatementFiles } from "@/lib/patient-statement-export";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { Modal } from "./Modal";
import { PatientStatementDocument } from "./PatientStatementDocument";
import { useSession } from "./SessionProvider";

const buttonClass = "min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-navy-800 disabled:opacity-50";
const inputClass = "mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";
class StatementAuthorityError extends Error {}

export function PatientStatementDialog({ patientId, disabled = false }: { patientId: number; disabled?: boolean }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  if (!session || !canViewMoney(session.role) || ((session.role === "cashier" || session.role === "accountant") && !financeAccessFor(session.role, session.permissions?.financeAccess).viewPatientLedger)) return null;
  const permissionKey = JSON.stringify(session.permissions?.financeAccess ?? null);
  return <>
    <button type="button" className={buttonClass} disabled={disabled} onClick={() => setOpen(true)}>كشف حساب</button>
    {open ? <StatementComposer key={`${patientId}:${session.username}:${session.role}:${permissionKey}`} patientId={patientId}
      username={session.username} role={session.role} onClose={() => setOpen(false)} /> : null}
  </>;
}

type Prepared = StatementFiles & { urls: string[] };

function StatementComposer({ patientId, username, role, onClose }: { patientId: number; username: string; role: string; onClose: () => void }) {
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [type, setType] = useState<PatientStatementType>("summary");
  const [period, setPeriod] = useState("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [treatmentId, setTreatmentId] = useState("");
  const [treatments, setTreatments] = useState<StatementDocument["treatments"]>([]);
  const [preview, setPreview] = useState<StatementDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingAuthority, setCheckingAuthority] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [recipient, setRecipient] = useState("");
  const [contentReviewed, setContentReviewed] = useState(false);
  const [recipientReviewed, setRecipientReviewed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [shareReady, setShareReady] = useState(0);
  const previewElement = useRef<HTMLDivElement>(null);
  const owner = useRef({ active: true, revision: 0, authorityCheck: 0, request: null as AbortController | null });
  const authority = useRef<{ id: number | undefined; permissions: string } | null>(null);

  const clear = () => {
    owner.current.revision++; owner.current.authorityCheck++; owner.current.request?.abort(); owner.current.request = null;
    setPreview(null); setPrepared(null); setError(""); setMessage(""); setLoading(false); setGenerating(false);
    setContentReviewed(false); setRecipientReviewed(false); setDownloaded(false); setShareReady(0); setCheckingAuthority(false);
  };

  useEffect(() => {
    const current = owner.current; current.active = true;
    return () => { current.active = false; current.revision++; current.request?.abort(); };
  }, []);
  useEffect(() => () => { prepared?.urls.forEach(url => URL.revokeObjectURL(url)); }, [prepared]);
  const current = (revision: number) => owner.current.active && owner.current.revision === revision;
  const verifySession = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/auth/me", { cache: "no-store", signal, headers: { Accept: "application/json" } });
    const session = response.ok ? await response.json() : null;
    const access = financeAccessFor(session?.role, session?.financeAccess ?? session?.permissions?.financeAccess);
    const permissions = JSON.stringify([session?.permissionVersion ?? null, access]);
    if (!session || session.username !== username || session.role !== role || !canViewMoney(session.role)
      || ((session.role === "cashier" || session.role === "accountant") && !access.viewPatientLedger)
      || (authority.current && (authority.current.id !== session.id || authority.current.permissions !== permissions))) {
      throw new StatementAuthorityError("تغيّر المستخدم أو صلاحياته. أغلق الكشف وافتحه من الجلسة الحالية.");
    }
    authority.current = { id: session.id, permissions };
  }, [username, role]);

  // Hide private content while checking a returning tab, but preserve a same-user file review.
  useEffect(() => {
    const refreshAuthority = async () => {
      if (document.visibilityState !== "visible") return;
      const revision = owner.current.revision;
      const check = ++owner.current.authorityCheck;
      setCheckingAuthority(true); setShareReady(0);
      try { await verifySession(); }
      catch (cause) { if (current(revision) && owner.current.authorityCheck === check) { clear(); setError(cause instanceof Error ? cause.message : "تعذر التحقق من الجلسة."); } }
      finally { if (current(revision) && owner.current.authorityCheck === check) setCheckingAuthority(false); }
    };
    window.addEventListener("focus", refreshAuthority);
    document.addEventListener("visibilitychange", refreshAuthority);
    return () => { window.removeEventListener("focus", refreshAuthority); document.removeEventListener("visibilitychange", refreshAuthority); };
  }, [verifySession]);

  const loadPreview = async () => {
    clear();
    const revision = owner.current.revision;
    const abort = new AbortController(); owner.current.request = abort;
    setLoading(true);
    try {
      const query = new URLSearchParams({ type });
      if (type === "period") {
        let start = from, end = to;
        if (period === "month") {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("اختر شهرًا صحيحًا.");
          start = `${month}-01`;
          end = `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()}`;
        } else if (period === "year") {
          if (!/^[1-9]\d{3}$/.test(year)) throw new Error("أدخل سنة صحيحة من أربعة أرقام.");
          start = `${year}-01-01`; end = `${year}-12-31`;
        }
        if (!start || !end || start > end) throw new Error("تحقق من بداية الفترة ونهايتها.");
        query.set("from", start); query.set("to", end);
      }
      if (type === "treatment") {
        if (!treatmentId) throw new Error("اختر العلاج أو الاتفاق. حمّل المختصر أولًا لعرض الخيارات.");
        query.set("treatmentId", treatmentId);
      }
      await verifySession(abort.signal);
      const response = await fetch(`/api/patients/${patientId}/statement?${query}`, { cache: "no-store", signal: abort.signal, headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "تعذر تحميل كشف الحساب. أعد المحاولة.");
      if (!data.patient || !Array.isArray(data.sections) || !Array.isArray(data.treatments) || !Array.isArray(data.notices)) throw new Error("وصل كشف غير مكتمل. أعد المحاولة.");
      await verifySession(abort.signal);
      if (!current(revision)) return;
      setPreview(data); setTreatments(data.treatments); setRecipient(data.patient.phone ?? "");
    } catch (cause) {
      if (current(revision) && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "تعذر تحميل الكشف.");
    } finally { if (current(revision)) setLoading(false); }
  };

  // The keyed composer is a new patient/session each mount; load only its initial summary.
  const initialPreview = useRef(loadPreview);
  useEffect(() => { void initialPreview.current(); }, []);

  const prepare = async (format: "pdf" | "png") => {
    if (!preview || loading || generating || checkingAuthority || !previewElement.current) return;
    const revision = owner.current.revision;
    setGenerating(true); setPrepared(null); setError(""); setMessage(""); setDownloaded(false); setContentReviewed(false); setRecipientReviewed(false);
    try {
      await verifySession();
      if (!current(revision)) return;
      const files = await createStatementFiles(preview, format, getComputedStyle(previewElement.current).fontFamily);
      if (!current(revision)) return;
      await verifySession();
      if (!current(revision)) return;
      setPrepared({ ...files, urls: files.previews.map(blob => URL.createObjectURL(blob)) });
    } catch (cause) { if (current(revision)) { if (cause instanceof StatementAuthorityError) clear(); setError(cause instanceof Error ? cause.message : "تعذر تجهيز الملف. أعد المحاولة."); } }
    finally { if (current(revision)) setGenerating(false); }
  };

  const printPreview = async () => {
    if (!preview || checkingAuthority || !previewElement.current) return;
    const revision = owner.current.revision;
    // Open while the click still has user activation, then authorize before copying any patient content.
    const popup = window.open("", "_blank");
    if (!popup) { setError("تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة."); return; }
    popup.opener = null;
    try {
      await verifySession();
      if (!current(revision) || !previewElement.current) { popup.close(); return; }
      popup.document.documentElement.lang = "ar"; popup.document.documentElement.dir = "rtl";
      popup.document.documentElement.className = document.documentElement.className;
      popup.document.title = "كشف حساب";
      document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => popup.document.head.append(node.cloneNode(true)));
      const style = popup.document.createElement("style");
      style.textContent = "body{margin:0;background:white;font-family:" + getComputedStyle(previewElement.current).fontFamily + ";} @page{size:A4;margin:12mm;}";
      popup.document.head.append(style);
      popup.document.body.append(previewElement.current.cloneNode(true));
      await popup.document.fonts.ready;
      await Promise.all(Array.from(popup.document.images).map(img => img.decode()));
      if (!current(revision)) { popup.close(); return; }
      popup.focus(); popup.print();
    } catch (cause) { popup.close(); if (current(revision)) { if (cause instanceof StatementAuthorityError) clear(); setError(cause instanceof Error ? cause.message : "تعذرت الطباعة."); } }
  };

  const authorizeShare = async () => {
    if (!prepared || !contentReviewed || !recipientReviewed || !statementRecipient(recipient)) return;
    const revision = owner.current.revision;
    try {
      await verifySession();
      if (!current(revision)) return;
      if (!supportsStatementFileShare(prepared.files)) {
        setMessage("مشاركة الملفات غير مدعومة هنا. نزّل الملف ثم افتح واتساب وأرفقه يدويًا."); return;
      }
      setShareReady(Date.now() + 15_000);
      setMessage("تم التحقق من الجلسة. اضغط اختيار تطبيق المشاركة، ثم اختر واتساب والمستلم.");
    } catch (cause) { if (current(revision)) { clear(); setError(cause instanceof Error ? cause.message : "تعذر التحقق من الجلسة."); } }
  };

  const share = async () => {
    if (!prepared || !contentReviewed || !recipientReviewed || !statementRecipient(recipient)) return;
    if (Date.now() > shareReady) { setShareReady(0); setMessage("أعد التحقق من جاهزية المشاركة ثم اختر التطبيق."); return; }
    const revision = owner.current.revision;
    if (!supportsStatementFileShare(prepared.files)) {
      setMessage("مشاركة الملفات غير مدعومة هنا. نزّل الملف ثم افتح واتساب وأرفقه يدويًا."); return;
    }
    try {
      // Prepared files make this call synchronous with the explicit user gesture (required on phones).
      await navigator.share({ files: prepared.files, title: "كشف حساب" });
      if (current(revision)) { setShareReady(0); setMessage("انتهت نافذة مشاركة الجهاز. تحقق من المستلم والإرفاق داخل واتساب؛ لا تتوفر حالة إرسال أو تسليم هنا."); }
    } catch (cause) {
      if (!current(revision)) return;
      if (cause instanceof Error && cause.name === "AbortError") setMessage("أُلغيت المشاركة.");
      else setError("تعذرت مشاركة الملف. يمكنك تنزيله ثم إرفاقه يدويًا في واتساب.");
    }
  };

  const download = async (file: File) => {
    const revision = owner.current.revision;
    try { await verifySession(); if (current(revision)) { downloadStatementFile(file); setDownloaded(true); } }
    catch (cause) { if (current(revision)) { clear(); setError(cause instanceof Error ? cause.message : "تعذر التحقق قبل التنزيل."); } }
  };

  const canShare = !checkingAuthority && !!prepared && contentReviewed && recipientReviewed && !!statementRecipient(recipient);
  return <Modal onClose={onClose} label="إعداد كشف حساب المريض" alignTop initialFocus="[data-statement-type]">
    <div dir="rtl" className="w-full max-w-5xl rounded-2xl bg-canvas p-3 shadow-xl sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-xl font-extrabold">كشف حساب</h2><button type="button" className={buttonClass} onClick={onClose}>إغلاق الكشف</button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-bold">نوع الكشف<select data-statement-type className={inputClass} value={type} onChange={event => { clear(); setType(event.target.value as PatientStatementType); }}>
          {Object.entries(PATIENT_STATEMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {type === "treatment" ? <label className="text-sm font-bold">العلاج أو الاتفاق<select className={inputClass} value={treatmentId} onChange={event => { clear(); setTreatmentId(event.target.value); }}>
          <option value="">اختر العلاج أو الاتفاق</option>{treatments.map(treatment => <option key={treatment.id} value={treatment.id}>{treatment.title}</option>)}
        </select>{!treatments.length ? <span className="block text-xs text-slate-600">اعرض المختصر أولًا لتحميل العلاجات المتاحة.</span> : null}</label> : null}
        {type === "period" ? <>
          <label className="text-sm font-bold">الفترة<select className={inputClass} value={period} onChange={event => { clear(); setPeriod(event.target.value); }}><option value="month">شهرية</option><option value="year">سنوية</option><option value="custom">من / إلى</option></select></label>
          {period === "month" ? <label className="text-sm font-bold">الشهر<input className={inputClass} type="month" value={month} onChange={event => { clear(); setMonth(event.target.value); }} /></label> : period === "year" ? <label className="text-sm font-bold">السنة<input className={inputClass} type="number" min="1900" max="9999" value={year} onChange={event => { clear(); setYear(event.target.value); }} /></label> : <>
            <label className="text-sm font-bold">من تاريخ<input type="date" className={inputClass} value={from} onChange={event => { clear(); setFrom(event.target.value); }} /></label>
            <label className="text-sm font-bold">إلى تاريخ<input type="date" className={inputClass} value={to} onChange={event => { clear(); setTo(event.target.value); }} /></label>
          </>}
        </> : null}
      </div>
      <button type="button" onClick={() => void loadPreview()} disabled={loading} className="my-4 min-h-11 rounded-xl bg-navy-800 px-5 py-2 text-sm font-bold text-white disabled:opacity-50">{loading ? "جارٍ تحميل الكشف…" : "معاينة الكشف"}</button>
      {error ? <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p> : null}
      {checkingAuthority ? <p role="status">جارٍ التحقق من الجلسة…</p> : null}
      {preview && !checkingAuthority ? <>
        <div ref={previewElement}><PatientStatementDocument document={preview} /></div>
        <div className="my-4 flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={generating} onClick={() => void printPreview()}>طباعة المعاينة</button>
          <button type="button" className={buttonClass} disabled={generating} onClick={() => void prepare("pdf")}>تجهيز ملف PDF</button>
          <button type="button" className={buttonClass} disabled={generating} onClick={() => void prepare("png")}>تجهيز صور PNG</button>
        </div>
        {generating ? <p role="status">جارٍ تجهيز الملف بالخط العربي والشعار…</p> : null}
      </> : <p className="text-sm text-slate-600">اختر النوع والفترة ثم اعرض الكشف قبل طباعته أو مشاركته.</p>}
      {prepared && !checkingAuthority ? <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4" aria-label="ملفات الكشف والمشاركة">
        <h3 className="mb-2 font-bold">راجع الملف قبل المشاركة</h3>
        <div className="mb-3 flex gap-3 overflow-x-auto">{prepared.urls.map((url, index) => <a href={url} target="_blank" rel="noopener noreferrer" key={url} className="shrink-0"><img src={url} alt={`معاينة صفحة الكشف ${index + 1}`} className="h-56 w-auto border border-slate-200" /></a>)}</div>
        <div className="flex flex-wrap gap-2">{prepared.files.map((file, index) => <button type="button" key={file.name} className={buttonClass} onClick={() => void download(file)}>تنزيل {file.type === "application/pdf" ? "PDF" : `الصورة ${index + 1}`}</button>)}</div>
        <label className="my-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={contentReviewed} onChange={event => { setContentReviewed(event.target.checked); setShareReady(0); }} />راجعت محتوى الكشف والملف</label>
        <label className="block text-sm font-bold">رقم مستلم واتساب بالرمز الدولي<input dir="ltr" className={inputClass} type="tel" inputMode="tel" placeholder="+967…" value={recipient} onChange={event => { setRecipient(event.target.value); setRecipientReviewed(false); setShareReady(0); }} /></label>
        {recipient && !statementRecipient(recipient) ? <p className="mt-1 text-xs text-amber-800">أدخل الرقم بالرمز الدولي، مثل +967، ثم راجعه.</p> : null}
        <label className="my-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={recipientReviewed} disabled={!statementRecipient(recipient)} onChange={event => { setRecipientReviewed(event.target.checked); setShareReady(0); }} />راجعت رقم المستلم: <bdi>{recipient}</bdi></label>
        <p className="mb-3 text-xs text-slate-600">اختر واتساب والمستلم بنفسك في نافذة مشاركة الجهاز. عند عدم دعم الملفات، نزّل الملف ثم أرفقه يدويًا. فتح واتساب أو إغلاق نافذة المشاركة لا يؤكد الإرسال أو التسليم.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!canShare} onClick={() => void authorizeShare()}>مشاركة الملف عبر الجهاز</button>
          {canShare && shareReady > 0 ? <button type="button" className={buttonClass} onClick={() => void share()}>اختيار تطبيق المشاركة</button> : null}
          {canShare && downloaded ? <a className={buttonClass} href={statementWhatsAppUrl(recipient)!} target="_blank" rel="noopener noreferrer">فتح واتساب للإرفاق اليدوي</a> : null}
        </div>
      </section> : null}
      {message ? <p role="status" className="mt-3 rounded-xl bg-blue-50 p-3 text-sm">{message}</p> : null}
    </div>
  </Modal>;
}
