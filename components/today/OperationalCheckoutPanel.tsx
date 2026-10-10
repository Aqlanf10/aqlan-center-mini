"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/money";
import { readOperationalCheckout, type OperationalCheckoutRead, type OperationalHandoff } from "@/lib/operational-checkout";

export function OperationalCheckoutPanel({ row, username, role, onChanged }: {
  row: OperationalHandoff; username: string; role: string; onChanged: () => void;
}) {
  const [verified, setVerified] = useState<OperationalCheckoutRead | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving">("loading");
  const [reason, setReason] = useState("");
  const life = useRef({ active: false, epoch: 0 });
  const load = useCallback(async () => {
    const epoch = ++life.current.epoch;
    setVerified(null); setState("loading");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/visits/${row.visitId}/operational-checkout`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Unavailable");
      const accepted = readOperationalCheckout(await response.json(), { username, role }, row);
      if (!accepted) throw new Error("Unverified");
      if (life.current.active && life.current.epoch === epoch) { setVerified(accepted); setState("ready"); }
    } catch { if (life.current.active && life.current.epoch === epoch) { setVerified(null); setState("error"); } }
    finally { clearTimeout(timeout); }
  }, [row.visitId, row.patientId, row.finishVersion, username, role]);
  useEffect(() => {
    life.current.active = true; void load();
    return () => { life.current.active = false; life.current.epoch++; };
  }, [load]);

  async function decide(status: "handled" | "deferred") {
    if (state !== "ready" || !verified || verified.item.patientId === null || reason.trim().length < 3) return;
    setState("saving");
    const epoch = ++life.current.epoch;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/visits/${row.visitId}/operational-checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: verified.item.patientId, finishVersion: verified.item.finishVersion,
          receivable: verified.receivable, status, reason: reason.trim() }),
      });
      if (!response.ok) throw new Error("Decision not verified");
      if (!life.current.active || life.current.epoch !== epoch) return;
      // Read the persisted first decision, including when a retry raced a successful response.
      await load(); onChanged();
    } catch {
      if (life.current.active && life.current.epoch === epoch) { setVerified(null); setState("error"); }
    } finally { clearTimeout(timeout); }
  }
  const ready = state === "ready" && verified !== null;
  return <section aria-label={`متابعة الخروج التشغيلي للزيارة ${row.visitId}`} data-operational-state={state}
    className="mt-2 w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
    <p className="font-bold">انتهى الجلوس؛ التوثيق السريري غير مسجّل.</p>
    <p>الفواتير والتحصيل من حساب المريض وفق الصلاحية. لا يُنشئ هذا العرض فاتورة أو توقيعًا.</p>
    {state === "loading" && <p role="status">جارٍ التحقق من هذه الزيارة…</p>}
    {state === "error" && <p role="alert">تعذّر التحقق، أو تغيّرت الزيارة. حالة التحصيل غير متاحة؛ حدّث قبل أي قرار.</p>}
    <button type="button" disabled={state === "saving"} onClick={() => { void load(); onChanged(); }} className="min-h-11 rounded-xl border px-3">إعادة التحقق من الزيارة</button>
    {ready && <>
      {verified.receivable === null ? <p data-testid="operational-visit-invoice">لا توجد فاتورة مرتبطة بهذه الزيارة. هذا لا يعني أن حساب المريض مسدّد.</p>
        : verified.receivable.status === "cancelled" ? <p data-testid="operational-visit-invoice">فاتورة الزيارة #{verified.receivable.invoiceId} ملغاة؛ راجع الحساب، ولا تفترض وجود فاتورة بديلة مرتبطة.</p>
          : <p data-testid="operational-visit-invoice">فاتورة الزيارة #{verified.receivable.invoiceId}: صافي المستند {formatMoney(verified.receivable.netMinor, verified.receivable.currency)}؛ صافي السندات المرتبطة مباشرة {formatMoney(verified.receivable.paidMinor, verified.receivable.currency)}. لا يُستنتج المتبقي من هذين الرقمين؛ راجع رصيد الحساب وتخصيص الدفعات، خصوصًا بعد تصحيح الفاتورة.</p>}
      <a className="inline-flex min-h-11 items-center rounded-xl bg-navy-800 px-3 text-white"
        href={`/patients/${verified.item.patientId}?tab=account`}>فتح حساب المريض واختيار فاتورة أو هدف تحصيل صريح</a>
      <p>الفواتير الأخرى في الحساب ليست مرتبطة بهذه الزيارة تلقائيًا. إنهاء المتابعة أو تأجيلها لا يسدّد أي دين.</p>
      {verified.item.status !== "pending" ? <p role="status">{verified.item.status === "deferred" ? "أُجّلت المتابعة" : "تمت معالجة المتابعة"}: {verified.item.handledReason}. يُحفظ القرار الأول ما دام استحقاق الزيارة لم يتغيّر.</p>
        : <>
          {verified.item.handledReason && <p role="status">{verified.item.handledReason}</p>}
          <label className="block">سبب المعالجة أو التأجيل
            <input maxLength={300} value={reason} onChange={event => setReason(event.target.value)} className="block min-h-11 w-full rounded-xl border px-2" />
          </label>
          <button type="button" disabled={reason.trim().length < 3} onClick={() => { void decide("handled"); }} className="min-h-11 rounded-xl border px-3">تمت مراجعة الخروج — لا يثبت السداد</button>
          <button type="button" disabled={reason.trim().length < 3} onClick={() => { void decide("deferred"); }} className="min-h-11 rounded-xl border px-3">تأجيل المتابعة مع بقاء الرصيد</button>
        </>}
    </>}
    {state === "saving" && <p role="status">جارٍ حفظ القرار…</p>}
  </section>;
}
