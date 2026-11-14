"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ActionButton, PageHeader } from "@/components/PageHeader";
import { CURRENCIES, formatMoney, type Currency } from "@/lib/money";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/expenses";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import type { CanonicalShiftFeed } from "@/lib/canonical-shifts";
import type { ReceiptProvenance } from "@/lib/receipt-provenance";

const empty = () => ({ YER: "", SAR: "", USD: "" });
const inputClass = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-navy-900";

function AmountInputs({ label, value, onChange }: { label: string; value: Record<Currency, string>; onChange: (next: Record<Currency, string>) => void }) {
  return <div className="grid gap-3 sm:grid-cols-3">{CURRENCIES.map(currency => <label key={currency} className="text-xs font-semibold text-slate-600">
    {label} {currency}<input aria-label={`${label} ${currency}`} inputMode="decimal" autoComplete="off" className={inputClass}
      value={value[currency]} onChange={event => onChange({ ...value, [currency]: event.target.value })} />
  </label>)}</div>;
}

/** Text only. Receipt printing/export routes are not part of this slice. */
function ReceiptState({ value, currency }: { value?: ReceiptProvenance; currency: Currency }) {
  if (!value) return null;
  return <div className="mt-1 text-xs text-amber-900">
    {value.status === "unavailable" || value.correctionUnverified ? <p>حالة السند غير متحققة.</p> : null}
    {value.reversal?.state === "full" ? <p>عُكس بالكامل؛ مبلغ السند الأصلي محفوظ.</p> : null}
    {value.reversal?.state === "partial" && value.reversal.remainingMinor !== null ? <p>عُكس جزئيًا؛ المتبقي {formatMoney(value.reversal.remainingMinor, currency)}.</p> : null}
    {value.reversal?.state === "unverified" ? <p>حالة العكس غير متحققة.</p> : null}
    {value.reversalOf ? <p>عكس السند <bdi>{value.reversalOf.receiptNumber}</bdi></p> : null}
    {value.replacementOf ? <p>بديل للسند <bdi>{value.replacementOf.receiptNumber}</bdi></p> : null}
    {value.correction ? <p>{value.correction.mode === "void" ? "إبطال المتبقي" : "تصحيح"}: <bdi>{value.correction.reversal.receiptNumber}</bdi>{value.correction.replacement ? <>، البديل <bdi>{value.correction.replacement.receiptNumber}</bdi></> : null}</p> : null}
  </div>;
}

export function CanonicalShifts({ username }: { username: string }) {
  const [feed, setFeed] = useState<CanonicalShiftFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [opening, setOpening] = useState(empty);
  const [counted, setCounted] = useState(empty);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const sequence = useRef(0), inFlight = useRef(false);
  const previousShift = useRef<number | null | undefined>(undefined);
  // A tab-local reminder survives refresh/navigation; it is neither authority nor
  // a durable request key. No command is ever retried automatically.
  const recoveryKey = `aqlan.shift.uncertain:${username}`;
  const markRecovery = useCallback((value: boolean) => {
    setRecovery(value);
    try { if (value) sessionStorage.setItem(recoveryKey, "1"); else sessionStorage.removeItem(recoveryKey); } catch { /* In-memory lock still applies. */ }
  }, [recoveryKey]);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setFeed(null); setError(null);
    let failureMessage = "تعذّر تحميل الصندوق. أعد القراءة.";
    try {
      const response = await fetch("/api/shifts", { cache: "no-store" });
      if (!response.ok) {
        failureMessage = response.status === 401 ? "انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد." : response.status === 403 ? "لا تملك صلاحية عرض الصندوق." : failureMessage;
        throw new Error("shift read refused");
      }
      const body = await response.json();
      if (!body || typeof body.canOperate !== "boolean" || !body.projection || !Array.isArray(body.recent)) throw new Error("تعذّر التحقق من بيانات الصندوق.");
      if (current !== sequence.current) return false;
      const next = body as CanonicalShiftFeed;
      const id = next.open?.id ?? null;
      if (previousShift.current !== undefined && previousShift.current !== id) {
        setOpening(empty()); setCounted(empty()); setNote(""); setReason(""); setNeedsReason(false);
      }
      previousShift.current = id;
      setFeed(next);
      return true;
    } catch {
      if (current === sequence.current) { setFeed(null); setError(failureMessage); }
      return false;
    } finally { if (current === sequence.current) setLoading(false); }
  }, []);
  const invalidateRead = useCallback(() => { ++sequence.current; }, []);

  useEffect(() => {
    try { setRecovery(sessionStorage.getItem(recoveryKey) === "1"); } catch { /* No stored data. */ }
    void load();
    const refresh = () => { if (!inFlight.current && document.visibilityState === "visible") void load(); };
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { invalidateRead(); window.clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, invalidateRead, recoveryKey]);

  async function submit(event: FormEvent, kind: "open" | "close") {
    event.preventDefault();
    if (inFlight.current || recovery || !feed?.canOperate || loading) return;
    inFlight.current = true; setBusy(true); setMessage(null); setError(null);
    markRecovery(true); // Also covers leaving this page while the request is pending.
    try {
      const response = await fetch("/api/shifts", { method: kind === "open" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "open" ? { opening } : { id: feed.open?.id, counted, note, differenceReason: reason }) });
      const body = await response.json();
      if (response.status >= 500) throw new Error("uncertain");
      if (!response.ok) {
        markRecovery(false);
        if (body?.code === "difference_reason_required") setNeedsReason(true);
        setMessage(typeof body?.message === "string" ? body.message : "رُفضت العملية. راجع بيانات الصندوق.");
      } else {
        if (!Number.isSafeInteger(body?.id) || !["open", "closed"].includes(body?.status)) throw new Error("uncertain");
        markRecovery(false); setNeedsReason(false); setCounted(empty()); setOpening(empty()); setReason(""); setNote("");
        setMessage(kind === "open" ? "فُتحت الوردية وسُجّلت العملية." : "أُقفلت الوردية وسُجّل الجرد.");
      }
    } catch {
      markRecovery(true);
      setMessage("لم يصل تأكيد العملية. تحقق من الصندوق وآخر الورديات قبل أي أمر جديد.");
    } finally {
      // GET only: it can establish the current state, but cannot prove which old
      // request created a shift that another operator has already closed.
      await load(); inFlight.current = false; setBusy(false);
    }
  }

  async function acknowledgeNewIntent() {
    if (inFlight.current || !feed || loading) return;
    inFlight.current = true; setBusy(true);
    try { if (await load()) { markRecovery(false); setMessage("تمت إعادة التحقق. اختر العملية الجديدة وأدخل بياناتها."); setOpening(empty()); setCounted(empty()); setReason(""); setNote(""); setNeedsReason(false); } }
    finally { inFlight.current = false; setBusy(false); }
  }
  const disabled = busy || recovery || loading;
  const date = (value: string) => new Intl.DateTimeFormat("ar-YE", { dateStyle: "medium", timeStyle: "short", timeZone: feed?.clinicTimeZone ?? CLINIC_ZONE_FALLBACK }).format(new Date(value));
  return <div className="mx-auto max-w-6xl space-y-5" data-testid="canonical-shifts">
    <PageHeader title="الصندوق والورديات" subtitle="رصيد الصندوق كامل، وتفاصيل الحركات بحسب صلاحياتك ونطاق مرضاك.">
      <ActionButton tone="quiet" disabled={busy || loading} onClick={() => void load()}>تحديث بيانات الصندوق</ActionButton>
    </PageHeader>
    {loading ? <p role="status" className="rounded-xl bg-slate-100 p-4 text-sm">جارٍ التحقق من الصندوق…</p> : null}
    {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error} <button className="font-bold underline" onClick={() => void load()} disabled={busy}>إعادة القراءة</button></div> : null}
    {message ? <p role="status" className="rounded-xl border border-slate-200 bg-white p-3 text-sm">{message}</p> : null}
    {recovery && !busy ? <section aria-label="التحقق من نتيجة العملية" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <p>نتيجة الأمر السابق غير مؤكدة. راجع حالة الصندوق وآخر الورديات؛ ربما فُتحت الوردية ثم أُقفلت. لن تُعاد العملية تلقائيًا.</p>
      <ActionButton tone="quiet" disabled={!feed || loading} onClick={() => void acknowledgeNewIntent()}>راجعت النتيجة وأريد بدء عملية جديدة</ActionButton>
    </section> : null}
    {feed ? <>
      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card" aria-label="إجمالي الصندوق">
        <h2 className="font-bold text-navy-900">{feed.open ? `الوردية المفتوحة #${feed.open.id}` : "لا توجد وردية مفتوحة"}</h2>
        {feed.open && feed.drawer ? <>
          <p className="text-xs text-slate-600">فتحها {feed.open.openedBy} — {date(feed.open.openedAt)}</p>
          <div className="overflow-x-auto"><table className="w-full text-right text-xs sm:text-sm"><thead><tr><th className="p-2">الحركة</th>{CURRENCIES.map(c => <th className="p-2" key={c}>{c}</th>)}</tr></thead>
            <tbody>{([
              ["opening", "الافتتاحي"], ["cashIn", "المقبوض نقدًا"], ["cashRefunds", "المردود نقدًا"], ["spent", "المصروف"],
              ["expected", "المتوقع في الدرج"], ["nonCashIn", "المقبوض غير النقدي"], ["nonCashRefunds", "المردود غير النقدي"],
            ] as const).map(([key, label]) => <tr key={key} className={`border-t border-slate-100 ${key === "expected" ? "bg-navy-50 font-bold" : ""}`}><th className="p-2">{label}</th>{CURRENCIES.map(c => <td key={c} className="whitespace-nowrap p-2"><bdi>{formatMoney(feed.drawer![key][c], c)}</bdi></td>)}</tr>)}</tbody>
          </table></div><p className="text-xs text-slate-500">المبالغ غير النقدية لا تدخل المتوقّع في الدرج. إخفاء التفاصيل لا يغيّر هذه الإجماليات.</p>
        </> : null}
      </section>
      {feed.canOperate ? <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card" aria-label={feed.open ? "جرد وإقفال الوردية" : "فتح الوردية"}>
        <form className="space-y-4" onSubmit={event => void submit(event, feed.open ? "close" : "open")}>
          <h2 className="font-bold text-navy-900">{feed.open ? "جرد وإقفال الوردية" : "فتح وردية جديدة"}</h2>
          <fieldset disabled={disabled} className="space-y-3">
            <AmountInputs label={feed.open ? "المعدود" : "الافتتاحي"} value={feed.open ? counted : opening} onChange={feed.open ? setCounted : setOpening} />
            {feed.open ? <>
              <label className="block text-xs font-semibold text-slate-600">ملاحظة الإقفال<input className={inputClass} maxLength={300} value={note} onChange={event => setNote(event.target.value)} /></label>
              {needsReason ? <label className="block text-xs font-semibold text-amber-900">سبب فرق الجرد<input required className={inputClass} maxLength={300} value={reason} onChange={event => setReason(event.target.value)} /></label> : null}
            </> : null}
            <ActionButton type="submit" disabled={disabled}>{busy ? "جارٍ تنفيذ العملية…" : feed.open ? "تأكيد الجرد والإقفال" : "تأكيد فتح وردية جديدة"}</ActionButton>
          </fieldset>
        </form>
      </section> : <p className="text-sm text-slate-600">عرض فقط؛ فتح الوردية وإقفالها يحتاجان صلاحية تشغيل الصندوق.</p>}
      <section aria-label="سندات الوردية" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="font-bold text-navy-900">سندات الوردية {feed.projection.patientScope === "own" && feed.projection.payments ? "— ضمن مرضاك" : ""}</h2>
        {!feed.projection.payments ? <p className="text-sm text-slate-500">تفاصيل السندات غير متاحة لصلاحياتك ونطاق مرضاك.</p> : <>
          {feed.paymentsTruncated ? <p role="note" className="text-sm text-amber-900">تُعرض أحدث 1000 حركة ضمن نطاقك؛ إجمالي الصندوق يشمل كل الحركات.</p> : null}
          {!feed.payments?.length ? <p className="text-sm text-slate-500">لا توجد سندات ظاهرة ضمن نطاقك في الوردية المفتوحة.</p> : null}
          <ul className="divide-y divide-slate-100">{feed.payments?.map(row => <li key={row.id} className="py-3" data-payment-id={row.id}>
            <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-bold text-navy-900">{row.patientName} — <bdi>{row.receiptNumber}</bdi></span><bdi>{formatMoney(row.amountMinor, row.currency)}</bdi></div>
            <p className="text-xs text-slate-500">{row.kind === "refund" ? "استرداد" : "قبض"} · {row.method === "cash" || !row.method ? "نقدًا" : "غير نقدي"} · {date(row.createdAt)}</p>
            {row.note ? <p className="mt-1 break-words text-xs">{row.note}</p> : null}<ReceiptState value={feed.receiptProvenance?.[row.id]} currency={row.currency} />
          </li>)}</ul>
        </>}
      </section>
      <section aria-label="مصروفات الوردية" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="font-bold text-navy-900">مصروفات الوردية</h2>
        {!feed.projection.expenses ? <p className="text-sm text-slate-500">تفاصيل المصروفات غير متاحة لصلاحياتك.</p> : <>
          {feed.expensesTruncated ? <p role="note" className="text-sm text-amber-900">تُعرض أحدث 1000 مصروف؛ إجمالي الصندوق يشمل كل المصروفات.</p> : null}
          {!feed.expenses?.length ? <p className="text-sm text-slate-500">لا توجد مصروفات في الوردية المفتوحة.</p> : null}
          <ul className="divide-y divide-slate-100">{feed.expenses?.map(row => <li key={row.id} className="py-3">
            <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-bold text-navy-900">{row.partyName || row.payeeText || "مصروف"} — <bdi>{row.voucherNumber}</bdi></span><bdi>{formatMoney(row.amountMinor, row.currency)}</bdi></div>
            <p className="text-xs text-slate-500">{EXPENSE_CATEGORY_LABEL[row.category] ?? row.category} · {date(row.createdAt)}</p>{row.note ? <p className="mt-1 break-words text-xs">{row.note}</p> : null}
          </li>)}</ul>
        </>}
      </section>
      <section aria-label="آخر الورديات" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="font-bold text-navy-900">آخر الورديات</h2>
        {!feed.recent.length ? <p className="text-sm text-slate-500">لا توجد ورديات مسجلة.</p> : null}
        <ul className="divide-y divide-slate-100">{feed.recent.map(row => <li key={row.id} className="space-y-1 py-3 text-xs">
          <p className="font-bold text-navy-900">#{row.id} — {row.status === "open" ? "مفتوحة" : "مقفلة"} — {date(row.openedAt)}</p>
          <p>فتحها {row.openedBy}{row.closedBy ? `، أقفلها ${row.closedBy}` : ""}</p>
          {row.counted ? <div className="grid gap-1 sm:grid-cols-3">{CURRENCIES.map(c => <p key={c}>{c}: المعدود <bdi>{formatMoney(row.counted![c], c)}</bdi> · الفرق <bdi>{formatMoney(row.difference?.[c] ?? 0, c)}</bdi></p>)}</div> : null}
          {row.note ? <p className="break-words">{row.note}</p> : null}{row.differenceReason ? <p className="break-words">سبب الفرق: {row.differenceReason}</p> : null}
        </li>)}</ul>
      </section>
    </> : null}
  </div>;
}
