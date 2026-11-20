"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { normalizeNumberingFormDigits, numberingDraft, numberingPreviewProblem, validNumberingSnapshot } from "./patient-numbering-preview-model";
import { isDefiniteSaveRefusal, readSaveSuccess, readSaveTicket, saveDraft, saveProblem, verifiedReadId,
  type NumberingReadGate, type NumberingSaveOperations, type NumberingSaveResult, type NumberingSaveTicket } from "./patient-numbering-save-model";

import type { SettingsNumberingCurrent } from "../../lib/patient-numbering-settings-contract";

export interface PatientNumberingSaveCandidateProps {
  current: SettingsNumberingCurrent;
  /** Default-deny until the host verifies current state and outstanding receipts on the server. */
  readGate?: NumberingReadGate;
  /** Merely asks the host to reconcile; calling this NEVER clears an uncertain operation. */
  onRequestReconciliation?: () => void;
  /** Client-parent synthetic injection only. No route, default provider or owner inference. */
  operations?: NumberingSaveOperations;
}
type Context = { key: string; operations: NumberingSaveOperations | undefined };
type Preview = { kind: "idle" } | { kind: "pending" | "refused"; context: Context; message?: string }
  | { kind: "ready"; context: Context; ticket: NumberingSaveTicket };
type Journal = { context: Context; ticket: NumberingSaveTicket; operations: NumberingSaveOperations;
  phase: "pending" | "uncertain" | "saved" | "refused"; blockedReads: ReadonlySet<string>; hadUncertain: boolean; message?: string;
  result?: Extract<NumberingSaveResult, { ok: true }> };

/** Unmounted candidate. All IO is explicitly injected; no real settings are wired. */
export function PatientNumberingSaveCandidate({ current, operations, readGate, onRequestReconciliation }: PatientNumberingSaveCandidateProps) {
  const id = useId();
  const [prefix, setPrefix] = useState(() => current.prefix.trim().toUpperCase());
  const [next, setNext] = useState(current.next ?? ""), [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });
  const [journal, setJournal] = useState<Journal | null>(null);
  const mounted = useRef(true), previewAttempt = useRef(0), previewFlight = useRef<number | null>(null);
  const ready = useRef<NumberingSaveTicket | null>(null), saveJournal = useRef<Journal | null>(null);
  const seenReads = useRef(new Set<string>());
  const readId = verifiedReadId(readGate);
  useLayoutEffect(() => { if (readId) seenReads.current.add(readId); }, [readId]);
  const key = JSON.stringify([current.prefix, current.next, current.revision, prefix, next, reason, readGate?.state, readId]);
  const [context, setContext] = useState<Context>({ key, operations });
  const contextChanged = context.key !== key || context.operations !== operations;
  if (contextChanged) setContext({ key, operations });
  useLayoutEffect(() => {
    previewAttempt.current += 1; previewFlight.current = null; ready.current = null;
  }, [context]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; previewAttempt.current += 1; ready.current = null; };
  }, []);
  const draft = saveDraft(prefix, next, reason), number = numberingDraft(prefix, next);
  const exhausted = current.next === null && /^[A-Z]$/.test(current.prefix) && Boolean(current.revision);
  const available = current.next === null ? null : numberingDraft(current.prefix, current.next);
  const snapshotValid = exhausted || (current.next !== null && validNumberingSnapshot({ ...current, next: current.next }));
  const currentPreview = exhausted ? "نفدت أرقام هذه السلسلة" : snapshotValid && available ? available.preview : "غير متاح";
  const sameContext = !contextChanged;
  const previewMatches = sameContext && preview.kind !== "idle" && preview.context === context;
  const readyTicket = previewMatches && preview.kind === "ready" ? preview.ticket : null;
  const journalMatches = sameContext && journal?.context === context;
  const pendingPreview = previewMatches && preview.kind === "pending";
  const needsFreshRead = journal !== null && (!readId || journal.blockedReads.has(readId));
  const frozen = journal?.phase === "pending" || journal?.phase === "uncertain" || needsFreshRead;
  const retryAvailable = journal?.phase === "uncertain" && journalMatches && journal.operations === operations;
  const status = journal ? !journalMatches
    ? "تغيّرت القيم المعروضة أو مصدر العملية. لا تنسب نتيجة الطلب السابق إلى هذه القيم؛ أعد قراءة حالة الترقيم قبل أي طلب جديد."
    : journal.phase === "pending" ? "جارٍ إرسال طلب الحفظ. لا تغيّر القيم أو تغلق النافذة حتى تظهر النتيجة."
    : journal.phase === "uncertain" ? "نتيجة الطلب غير مؤكدة؛ ربما نُفّذ. أعد محاولة الطلب نفسه دون تغيير معرّفه أو قيمه، أو راجع الحالة قبل طلب جديد."
    : journal.phase === "saved" ? journal.result?.replay
      ? "تم تأكيد تنفيذ الطلب السابق دون تكراره. هذه نتيجة ذلك الطلب وليست قراءةً جديدة للعداد الحالي."
      : "أكد المصدر نجاح طلب الحفظ لهذه المعاينة. أعد قراءة الحالة الحالية قبل أي تغيير آخر."
    : journal.message ?? numberingPreviewProblem("unavailable")
    : !readId ? "لم تُتحقق الحالة الحالية والطلبات السابقة من الخادم بعد. الفحص والحفظ متوقفان حتى تكتمل المراجعة."
    : preview.kind === "idle" ? ""
    : !previewMatches ? numberingPreviewProblem("stale-preview")
    : preview.kind === "pending" ? "جارٍ فحص القيم…"
    : preview.kind === "ready" ? "المعاينة جاهزة. راجع القيم وأكّد اختيارك قبل إرسال الحفظ. لم يُرسل طلب حفظ بعد."
    : preview.message;

  function updateJournal(value: Journal) { saveJournal.current = value; setJournal(value); }
  function edit(field: "prefix" | "next" | "reason", value: string) {
    // Native disabled fields are not the only guard; stale callbacks cannot edit a pending/unknown operation.
    const prior = saveJournal.current;
    if (prior && (prior.phase === "pending" || prior.phase === "uncertain" || !readId || prior.blockedReads.has(readId))) return;
    previewAttempt.current += 1; previewFlight.current = null; ready.current = null;
    if (field === "prefix") setPrefix(value); else if (field === "next") setNext(normalizeNumberingFormDigits(value)); else setReason(value);
    setConfirmed(false); setPreview({ kind: "idle" }); setJournal(null); saveJournal.current = null;
  }
  async function inspect() {
    if (!draft || !snapshotValid || (exhausted && draft.prefix === current.prefix) || !readId || !operations || previewFlight.current !== null || saveJournal.current !== null) return;
    const token = ++previewAttempt.current;
    previewFlight.current = token; ready.current = null; setConfirmed(false); setPreview({ kind: "pending", context });
    const stillCurrent = () => mounted.current && previewAttempt.current === token;
    try {
      const response = await operations.preview({ ...draft });
      if (!stillCurrent()) return;
      const ticket = response?.ok === true ? readSaveTicket(response.ticket, draft) : null;
      if (!ticket) { setPreview({ kind: "refused", context, message: numberingPreviewProblem(response?.ok === false ? response.reason : "invalid-response") }); return; }
      ready.current = ticket; setPreview({ kind: "ready", context, ticket });
    } catch {
      if (stillCurrent()) setPreview({ kind: "refused", context, message: numberingPreviewProblem("unavailable") });
    } finally { if (previewFlight.current === token) previewFlight.current = null; }
  }
  async function sendSave(retry = false) {
    const existing = saveJournal.current;
    let operation: Journal;
    if (retry) {
      if (!existing || existing.phase !== "uncertain" || !retryAvailable || existing.context !== context || existing.operations !== operations) return;
      operation = { ...existing, phase: "pending" };
    } else {
      if (existing || !readId || !confirmed || !readyTicket || ready.current !== readyTicket || !operations) return;
      operation = { context, ticket: { ...readyTicket }, operations, phase: "pending", blockedReads: new Set(seenReads.current), hadUncertain: false };
      ready.current = null;
    }
    updateJournal(operation);
    try {
      // Preserve the preview-issued revision, token, reason and requestId on every retry.
      const response = await operation.operations.save({ ...operation.ticket });
      if (!mounted.current || saveJournal.current !== operation) return;
      const success = readSaveSuccess(response, operation.ticket);
      // A read arriving before this outcome (or reused historical identity) is not
      // post-outcome reconciliation. Freeze all identities observed by settlement.
      if (success) { updateJournal({ ...operation, phase: "saved", blockedReads: new Set(seenReads.current), result: success }); return; }
      if (!operation.hadUncertain && response?.ok === false && isDefiniteSaveRefusal(response.reason)) {
        updateJournal({ ...operation, phase: "refused", blockedReads: new Set(seenReads.current), message: saveProblem(response.reason) }); return;
      }
      updateJournal({ ...operation, phase: "uncertain", hadUncertain: true });
    } catch {
      if (mounted.current && saveJournal.current === operation) updateJournal({ ...operation, phase: "uncertain", hadUncertain: true });
    }
  }
  const fieldClass = "min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-100";
  return <section dir="rtl" aria-labelledby={`${id}-title`} className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={`${id}-title`} className="text-sm font-extrabold text-navy-900">ترقيم ملفات المرضى</h2>
      <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900">مرشح اختبار غير موصول</span>
    </div>
    <p id={`${id}-scope`} className="mt-2 text-sm leading-6 text-slate-600">إعداد خاص بمالك العيادة، للملفات الجديدة فقط؛ أرقام الملفات الموجودة لا تتغيّر. هذه الواجهة غير موصولة بإعدادات العيادة. مصدر الفحص والحفظ محقون للاختبار فقط ولا يثبت صلاحية المالك.</p>
    <form onSubmit={event => { event.preventDefault(); void inspect(); }} aria-describedby={`${id}-scope`} className="mt-4 space-y-4">
      <fieldset disabled={frozen} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">اختيار السلسلة ورقم البداية</legend>
        <label htmlFor={`${id}-prefix`} className="text-sm font-bold">حرف السلسلة
          <select id={`${id}-prefix`} dir="ltr" value={prefix} onChange={e => edit("prefix", e.target.value)} className={`${fieldClass} mt-1 font-mono`}>
            <option value="">اختر حرفًا</option>{[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => <option key={letter} value={letter}>{letter}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-next`} className="text-sm font-bold">رقم البداية / الرقم التالي
          <input id={`${id}-next`} type="text" inputMode="numeric" dir="ltr" value={next} autoComplete="off" spellCheck={false}
            aria-invalid={!number || undefined} aria-describedby={`${id}-help`} onChange={e => edit("next", e.target.value)} className={`${fieldClass} mt-1 font-mono`} />
        </label>
        <label htmlFor={`${id}-reason`} className="text-sm font-bold sm:col-span-2">سبب التغيير
          <textarea id={`${id}-reason`} value={reason} rows={2} aria-describedby={`${id}-reason-help`} aria-invalid={(!reason.trim() || reason.length > 500) || undefined}
            onChange={e => edit("reason", e.target.value)} className={`${fieldClass} mt-1`} />
        </label>
      </fieldset>
      <p id={`${id}-help`} className="text-xs leading-5 text-slate-600">حرف واحد A–Z ورقم موجب حتى 18 خانة دون صفر بادئ. تُحوّل الأرقام العربية والفارسية إلى 0–9 في الحقل والمعاينة دون فقد الدقة.</p>
      <p id={`${id}-reason-help`} className="text-xs text-slate-600">سبب مختصر حتى 500 حرف، بلا بيانات مرضى.</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><dt>القيمة الحالية المعروضة</dt><dd className="break-all font-mono text-lg font-bold"><bdi dir="ltr">{currentPreview}</bdi></dd></div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3"><dt>القيمة المقترحة للملف الجديد</dt><dd className="break-all font-mono text-lg font-bold"><bdi dir="ltr">{number?.preview ?? "—"}</bdi></dd></div>
      </dl>
      {exhausted && <p role="status">لا يوجد رقم تالٍ للسلسلة <bdi dir="ltr">{current.prefix}</bdi>. اختر حرفًا آخر لفحص سلسلة مختلفة.</p>}
      {!snapshotValid && <p role="alert">القيم الحالية غير مكتملة. أعد قراءتها قبل المتابعة.</p>}
      {!operations && <p>مصدر الفحص والحفظ غير موصول.</p>}
      <button type="submit" disabled={!draft || !snapshotValid || (exhausted && draft.prefix === current.prefix) || !readId || !operations || pendingPreview || journal !== null} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 focus:ring-2 focus:ring-sky-500 disabled:opacity-50">فحص المعاينة</button>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!readyTicket || journal !== null}
        onChange={e => { if (ready.current && saveJournal.current === null) setConfirmed(e.target.checked); }} />أؤكد حرف السلسلة ورقم البداية وسبب التغيير في هذه المعاينة.</label>
      <button type="button" disabled={!readyTicket || !confirmed || journal !== null} onClick={() => void sendSave()} className="min-h-11 rounded-xl bg-navy-800 px-4 py-2 font-bold text-white focus:ring-2 focus:ring-sky-500 disabled:opacity-50">حفظ القيم المعاينة</button>
      {journal?.phase === "uncertain" && !retryAvailable && <p role="alert">إعادة المحاولة متوقفة لأن نسخة العرض أو مصدر العملية تغيّر. لا يمكن إنشاء طلب جديد؛ يلزم التحقق من الخادم من حالة الطلب السابق أو إيصاله المطابق.</p>}
      {journal?.phase === "uncertain" && <button type="button" disabled={!retryAvailable} onClick={() => void sendSave(true)} className="min-h-11 rounded-xl border border-amber-500 px-4 py-2 focus:ring-2 focus:ring-sky-500 disabled:opacity-50">إعادة محاولة الطلب نفسه</button>}
      {(!readId || journal) && <button type="button" disabled={!onRequestReconciliation} onClick={() => { try { onRequestReconciliation?.(); } catch { /* The gate stays closed; never infer reconciliation from a callback. */ } }} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 focus:ring-2 focus:ring-sky-500 disabled:opacity-50">طلب مراجعة الحالة من الخادم</button>}
      {needsFreshRead && journal?.phase !== "pending" && journal?.phase !== "uncertain" && <p>يلزم تأكيد قراءة جديدة للحالة قبل تعديل الاختيار أو بدء طلب آخر.</p>}
      <p role="status" aria-live="polite" aria-atomic="true" className="min-h-6 text-sm leading-6">{status}</p>
      {journal && !frozen && <p className="text-xs">عدّل اختيارك لبدء معاينة جديدة؛ لا تُعد استخدام نتيجة الطلب السابق كحالة حالية.</p>}
    </form>
  </section>;
}
