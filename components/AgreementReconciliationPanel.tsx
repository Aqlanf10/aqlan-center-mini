"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { MONEY_JOURNAL_EVENT } from "./useDurableMoneyAttempt";
import { formatMoney } from "@/lib/money";
import { acknowledgeFinancialCommand, readFinancialJournal, reserveFinancialCommand, type FinancialJournal } from "@/lib/financial-command-journal";
import type { AgreementReconciliationReceipt, AgreementReconciliationView } from "@/lib/agreement-reconciliation";
import { isReconciliationRejection, readReconciliationReceipt, readReconciliationView, reconciliationCommand, restoreReconciliationCommand } from "@/lib/agreement-reconciliation-view";

interface Props { patientId: number; planId: number; onChanged: () => void | Promise<void>; initiallyOpen?: boolean; disabled?: boolean }
const UNKNOWN = "لم تتأكد نتيجة الطلب. بقي الطلب محفوظًا؛ تحقّق من حالته أو أعد الطلب نفسه دون إنشاء تسوية أخرى.";
const announce = () => window.dispatchEvent(new Event(MONEY_JOURNAL_EVENT));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function AgreementReconciliationPanel(props: Props) {
  const session = useSession();
  if (!session || session.role !== "admin") return null;
  return <ReconciliationPanel key={JSON.stringify([props.patientId, props.planId, session])} {...props} actor={session.username} />;
}

function ReconciliationPanel({ patientId, planId, actor, onChanged, initiallyOpen = false, disabled = false }: Props & { actor: string }) {
  const region = useId();
  const [opened, setOpened] = useState(initiallyOpen);
  const [view, setView] = useState<AgreementReconciliationView | null>(null);
  const [journal, setJournal] = useState<FinancialJournal | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [reason, setReason] = useState("توحيد عرض الاتفاق وربط الجزء غير المفوتر");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rejectionProof, setRejectionProof] = useState<string | null>(null);
  const [completed, setCompleted] = useState<AgreementReconciliationReceipt | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef(0), sending = useRef(false), journalRead = useRef(0);
  const pending = journal?.command ? restoreReconciliationCommand(journal.command, patientId, actor) : null;
  const ownPending = pending?.planId === planId ? pending : null;
  const otherPending = !!journal?.command && !ownPending;
  const rejected = !!ownPending && rejectionProof === reconciliationCommand(ownPending).original;

  useEffect(() => { const owner = ++lifetime.current; return () => { lifetime.current = owner + 1; }; }, []);
  const syncJournal = useCallback(async () => {
    const owner = lifetime.current, read = ++journalRead.current;
    try {
      const saved = await readFinancialJournal({ actor, patientId });
      if (owner !== lifetime.current || read !== journalRead.current) return;
      setJournal(saved); setJournalError(null);
      const draft = saved.command && restoreReconciliationCommand(saved.command, patientId, actor);
      if (draft?.planId === planId) { setOpened(true); setReason(draft.body.reason); setCompleted(null); }
    } catch {
      if (owner === lifetime.current && read === journalRead.current) {
        setJournal(null); setJournalError("تعذّرت قراءة الطلب المالي المحفوظ. لم يُرسل طلب جديد؛ لا تمسح بيانات المتصفح.");
      }
    }
  }, [actor, patientId, planId]);
  useEffect(() => {
    void syncJournal();
    const sync = () => { void syncJournal(); };
    window.addEventListener(MONEY_JOURNAL_EVENT, sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener(MONEY_JOURNAL_EVENT, sync); window.removeEventListener("focus", sync); };
  }, [syncJournal]);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController(), owner = lifetime.current;
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 20000);
    setView(null); setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/plans/${planId}/reconcile`, { cache: "no-store", redirect: "manual", signal: controller.signal });
        const data: unknown = await response.json();
        if (!active || owner !== lifetime.current || controller.signal.aborted) return;
        const parsed = !response.redirected && response.ok && readReconciliationView(data, planId, patientId);
        if (!parsed) { setMessage(response.status === 403 || response.status === 401 ? "تحتاج جلسة مدير سارية لعرض التسوية." : "تعذّرت معاينة الاتفاق. لم يُسجّل أي مبلغ من المعاينة؛ أعد تحميلها."); return; }
        setView(parsed);
      } catch { if (active && owner === lifetime.current) setMessage("تعذّر تحميل المعاينة. أعد المحاولة دون تغيير أي طلب محفوظ."); }
      finally { clearTimeout(timeout); if (active && owner === lifetime.current) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [opened, planId, patientId, refresh]);

  const operate = async (mode: "submit" | "status") => {
    if (sending.current || disabled || !journal || journalError || otherPending || rejected) return;
    if (!ownPending && (mode === "status" || !view?.canConfirm || reason.trim().length < 3 || reason.trim().length > 300)) return;
    sending.current = true; setBusy(true); setMessage(null);
    const owner = lifetime.current;
    const current = () => owner === lifetime.current;
    let command = ownPending;
    let mayHaveReachedServer = !!ownPending;
    try {
      if (!command) {
        command = { actor, patientId, planId, body: { operationKey: crypto.randomUUID(), expectedSourceHash: view!.sourceHash, reason: reason.trim() } };
        const durable = reconciliationCommand(command);
        const saved = await reserveFinancialCommand({ actor, patientId }, journal.revision, durable);
        if (!current()) return;
        setJournal(saved); announce();
        if (saved.command?.original !== durable.original || saved.command.key !== durable.key) {
          setMessage("توجد عملية مالية محفوظة من شاشة أخرى. راجعها في الحساب قبل بدء التسوية."); return;
        }
      }
      if (!current()) return;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      let response: Response, data: unknown;
      try {
        mayHaveReachedServer = true;
        response = await fetch(`/api/plans/${planId}/reconcile`, { method: mode === "status" ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" }, redirect: "manual", cache: "no-store",
          body: JSON.stringify(command.body), signal: controller.signal });
        data = await response.json();
      } finally { clearTimeout(timeout); }
      if (!current()) return;
      const accepted = !response.redirected && response.ok && record(data)
        ? readReconciliationReceipt(mode === "status" && data.state === "committed" ? data.receipt : data.status === "reconciled" ? data.reconciliation : null, command) : null;
      if (accepted) {
        await acknowledgeFinancialCommand({ actor, patientId }, reconciliationCommand(command));
        if (!current()) return;
        setCompleted(accepted); setRejectionProof(null); setView(null); announce(); await syncJournal();
        setMessage("تمت تسوية الاتفاق. حُفظت الفواتير والسندات السابقة، ولم تُسجّل حركة قبض جديدة.");
        try { await onChanged(); } catch { if (current()) setMessage("التسوية محفوظة؛ تعذّر تحديث العرض فقط. حدّث الحساب دون إنشاء تسوية أخرى."); }
      } else if (!response.redirected && response.ok && mode === "status" && await isReconciliationRejection(data, command)) {
        if (current()) { setRejectionProof(reconciliationCommand(command).original); setMessage("ثبت أن الطلب المحفوظ رُفض دون حفظ بسبب تغير الحساب. يمكنك تحديث المعاينة بأمان."); }
      } else if (current()) {
        setMessage(response.status === 401 || response.status === 403
          ? "تغيّرت الجلسة أو الصلاحية. الطلب محفوظ؛ عُد بالحساب المصرّح له للتحقق من نتيجته."
          : record(data) && data.code === "agreement_source_changed" ? "تغيّر مصدر الاتفاق. تحقّق من حالة الطلب المحفوظ قبل تحديث المعاينة." : UNKNOWN);
      }
    } catch { if (current()) {
      setMessage(mayHaveReachedServer ? UNKNOWN : "تعذّر تثبيت الطلب في المتصفح أو تغيّر من شاشة أخرى. لم يُرسل طلب تسوية جديد؛ راجع العملية المحفوظة.");
      await syncJournal();
    } }
    finally { sending.current = false; if (current()) setBusy(false); }
  };
  const refreshRejected = async () => {
    if (!ownPending || !rejected || sending.current || disabled) return;
    sending.current = true; setBusy(true);
    const owner = lifetime.current;
    try {
      // Only a previously validated permanent server tombstone permits retirement.
      await acknowledgeFinancialCommand({ actor, patientId }, reconciliationCommand(ownPending));
      if (owner !== lifetime.current) return;
      setRejectionProof(null); setView(null); setMessage(null); announce(); await syncJournal(); setRefresh(v => v + 1);
    } catch { if (owner === lifetime.current) setMessage("تعذّر إغلاق الطلب المرفوض؛ احتفظ به وأعد المحاولة."); }
    finally { sending.current = false; if (owner === lifetime.current) setBusy(false); }
  };
  const amount = (value: number | null) => value === null ? "غير متحقق" : formatMoney(value, view!.currency);
  const button = "min-h-11 cursor-pointer rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  return <section dir="rtl" className="mt-3 min-w-0 rounded-2xl border border-slate-200 bg-white p-3" data-testid="agreement-reconciliation">
    <button type="button" aria-expanded={opened} aria-controls={region} className={button} disabled={busy || disabled}
      onClick={() => setOpened(v => !v)}>تسوية الاتفاق</button>
    {opened ? <div id={region} className="mt-3 min-w-0 space-y-3">
      <p className="text-sm leading-7">مراجعة الاتفاق وربط الجزء غير المفوتر فقط. الفواتير والسندات السابقة تبقى محفوظة، ولا تُسجّل دفعة جديدة.</p>
      {loading ? <p role="status" className="min-h-7 text-sm">جارٍ تحميل المعاينة…</p> : null}
      {journalError ? <p role="alert" className="text-sm text-rose-800">{journalError}</p> : null}
      {otherPending ? <p role="alert" className="text-sm text-amber-900">توجد عملية مالية أخرى محفوظة لهذا المريض. استكملها من الحساب أولًا.</p> : null}
      {view ? <>
        <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {([["قيمة الاتفاق", view.amounts.agreedMinor], ["فُوتر سابقًا", view.amounts.billedPrincipalMinor], ["المدفوع المثبت", view.amounts.paidMinor],
            ["المتبقي من الاتفاق", view.amounts.remainingMinor], ["القسط المستحق الآن", view.amounts.dueNowMinor], ["المبلغ الذي سيُضاف للفوترة", view.amounts.unbilledPrincipalMinor]] as const)
            .map(([label, value]) => <div key={label} className="min-w-0 rounded-xl bg-slate-50 p-3"><dt className="text-slate-600">{label}</dt><dd className="mt-1 break-words font-bold">{amount(value)}</dd></div>)}
        </dl>
        <p className="text-xs leading-6 text-slate-600">قبل التسوية: الفواتير الصادرة فقط في رصيد الحساب. بعدها: كامل الاتفاق من مصادره المثبتة، دون طرح المدفوع مرتين. حركة الصندوق الجديدة: صفر.</p>
        {view.sourceInvoices.length ? <details className="rounded-xl border p-3 text-sm"><summary className="cursor-pointer font-bold">الفواتير المحتسبة في المعاينة ({view.sourceInvoices.length})</summary>
          <ul className="mt-2 space-y-2">{view.sourceInvoices.map(s => <li key={s.invoiceId} className="break-words">{s.invoiceNumber} · أصل الفاتورة {amount(s.principalMinor)} · المسدّد {amount(s.settledMinor)} · المتبقي {amount(s.remainingMinor)}</li>)}</ul>
        </details> : null}
        {view.commission ? <p className="text-xs leading-6">الطبيب المثبت: {view.commission.doctorName} · نسبة العمولة {view.commission.percent}٪ · الاستحقاق الإضافي المعروض: {amount(view.commission.incrementalAccruedMinor)}. لم تُصرف عمولة من هذه المعاينة.</p> : null}
        {view.blockers.length ? <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><strong>تحتاج مراجعة قبل التسوية</strong><ul className="mt-1 list-inside list-disc">{view.blockers.map((b, i) => <li key={`${b.code}-${i}`}>{b.message}</li>)}</ul></div> : null}
        {view.status === "reconciled" ? <p role="status" className="text-sm text-emerald-800">هذا الاتفاق تمت تسويته بالفعل؛ لن تُضاف فاتورة ثانية.</p> : null}
      </> : null}
      {!completed && view?.status !== "reconciled" ? <label className="block text-sm font-bold">سبب التسوية (٣ أحرف على الأقل)
        <textarea className="mt-1 min-h-20 w-full resize-none rounded-xl border border-slate-300 p-2 font-normal" maxLength={300}
          value={reason} disabled={busy || !!ownPending || otherPending || disabled} onChange={e => setReason(e.target.value)} />
      </label> : null}
      {ownPending ? <p role="status" className="text-sm text-amber-900">طلب تسوية محفوظ. لن يُغيّر المبلغ أو المفتاح عند إعادة المحاولة.</p> : null}
      {message ? <p role={completed ? "status" : "alert"} className="text-sm leading-7">{message}</p> : null}
      {completed ? <p className="text-sm font-bold text-emerald-800">التسوية #{completed.id} محفوظة{completed.deltaInvoiceId ? ` · فاتورة الجزء غير المفوتر #${completed.deltaInvoiceId}` : " · دون إنشاء فاتورة إضافية"}.</p> : <div className="flex flex-wrap gap-2">
        {ownPending && !rejected ? <button type="button" className={button} disabled={busy || disabled} onClick={() => void operate("status")}>تحقق من حالة الطلب</button> : null}
        {rejected ? <button type="button" className={button} disabled={busy || disabled} onClick={() => void refreshRejected()}>تحديث المعاينة بعد الرفض المثبت</button>
          : <button type="button" className={`${button} bg-navy-800 text-white hover:bg-navy-900`} disabled={busy || disabled || !journal || !!journalError || otherPending || (!ownPending && (!view?.canConfirm || reason.trim().length < 3))}
            onClick={() => void operate("submit")}>{busy ? "جارٍ التحقق…" : ownPending ? "إعادة الطلب المحفوظ نفسه" : "تأكيد التسوية"}</button>}
        {!ownPending ? <button type="button" className={button} disabled={busy || loading || disabled} onClick={() => { setMessage(null); setRefresh(v => v + 1); }}>تحديث المعاينة</button> : null}
      </div>}
      {completed || view?.status === "reconciled" ? <div className="rounded-xl bg-slate-50 p-3 text-sm leading-7">
        <p>التحصيل التالي من مصادر الدين في الحساب، وليس بإصدار فاتورة قسط جديدة. اختر الفاتورة المقصودة وراجع المتبقي عليها؛ القسط المستحق الآن منفصل عن إجمالي المتبقي.</p>
        <a href={`/patients/${patientId}?tab=account`} className="inline-flex min-h-11 items-center font-bold text-navy-800 underline underline-offset-4">فتح الحساب للتحصيل من الفواتير المرتبطة</a>
      </div> : null}
    </div> : null}
  </section>;
}
