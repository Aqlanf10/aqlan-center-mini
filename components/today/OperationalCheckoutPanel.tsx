"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/money";
import { readOperationalCheckout, readOperationalRow, type OperationalCheckoutRead, type OperationalHandoff } from "@/lib/operational-checkout";
import { ArrowUpLeft, RefreshCw, X } from "lucide-react";
import styles from "./reception.module.css";

export function OperationalCheckoutPanel({ row, username, role, onChanged, onClose, onSaved }: {
  row: OperationalHandoff; username: string; role: string; onChanged: () => void; onClose: () => void; onSaved: () => void;
}) {
  const [verified, setVerified] = useState<OperationalCheckoutRead | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving">("loading");
  const [reason, setReason] = useState("");
  const life = useRef({ active: false, epoch: 0 });
  const writing = useRef(false);
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
    if (writing.current || state !== "ready" || !verified || verified.item.patientId === null || reason.trim().length < 3 || reason.trim().length > 300) return;
    writing.current = true;
    setState("saving");
    const epoch = ++life.current.epoch;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/visits/${row.visitId}/operational-checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: verified.item.patientId, finishVersion: verified.item.finishVersion,
          receivable: verified.receivable, status, reason: reason.trim() }),
      });
      const result = await response.json(), saved = readOperationalRow(result?.item);
      if (!response.ok || result?.ok !== true || !saved || saved.visitId !== row.visitId || saved.patientId !== verified.item.patientId
        || saved.finishVersion !== verified.item.finishVersion || saved.status === "pending" || saved.financialReviewRequired) throw new Error("Decision not verified");
      if (!life.current.active || life.current.epoch !== epoch) return;
      // POST returns the persisted first applicable decision, including on replay.
      onSaved();
    } catch {
      if (life.current.active && life.current.epoch === epoch) { setVerified(null); setState("error"); }
    } finally { writing.current = false; clearTimeout(timeout); }
  }
  const ready = state === "ready" && verified !== null;
  return <section aria-label={`متابعة الخروج التشغيلي للزيارة ${row.visitId}`} data-operational-state={state}
    className={styles.detail}>
    <header className={styles.detailHeading}><div><h3>{row.patientName} · زيارة #{row.visitId}</h3>
      <p>انتهى الجلوس؛ التوثيق السريري غير مسجّل.</p></div>
      <button type="button" onClick={onClose} className={styles.close} aria-label="إغلاق تفاصيل الخروج"><X size={18} aria-hidden="true" /></button>
    </header>
    {state === "loading" && <p role="status">جارٍ التحقق من هذه الزيارة…</p>}
    {state === "error" && <p role="alert">تعذّر التحقق، أو تغيّرت الزيارة. حالة التحصيل غير متاحة؛ حدّث قبل أي قرار.</p>}
    <button type="button" disabled={state === "saving"} onClick={() => { void load(); onChanged(); }} className={styles.subtle}><RefreshCw size={14} aria-hidden="true" />إعادة التحقق من الزيارة</button>
    {ready && <>
      {verified.item.visitInvoiceSettled && <p className={styles.debtNote}>فاتورة الزيارة مسدّدة؛ {verified.item.status === "pending" ? "المراجعة التشغيلية معلّقة وتحتاج قرارًا صريحًا" : "القرار التشغيلي مستقل عن رصيد الحساب"}.</p>}
      <div className={styles.invoice}>
      {verified.receivable === null ? <p data-testid="operational-visit-invoice">لا توجد فاتورة مرتبطة بهذه الزيارة. هذا لا يعني أن حساب المريض مسدّد.</p>
        : verified.receivable.status === "cancelled" ? <p data-testid="operational-visit-invoice">فاتورة الزيارة #{verified.receivable.invoiceId} ملغاة؛ راجع الحساب، ولا تفترض وجود فاتورة بديلة مرتبطة.</p>
          : <div data-testid="operational-visit-invoice"><p className={styles.invoiceTitle}>فاتورة الزيارة #{verified.receivable.invoiceId}</p>
              <dl className={styles.amounts}><div><dt>صافي المستند</dt><dd>{formatMoney(verified.receivable.netMinor, verified.receivable.currency)}</dd></div>
                <div><dt>صافي السندات المرتبطة مباشرة</dt><dd>{formatMoney(verified.receivable.paidMinor, verified.receivable.currency)}</dd></div></dl>
              <p className={styles.note}>لا يُستنتج المتبقي من هذين الرقمين؛ راجع رصيد الحساب وتخصيص الدفعات، خصوصًا بعد تصحيح الفاتورة.</p></div>}
      </div>
      <a className={styles.primary} href={`/patients/${verified.item.patientId}?tab=account`}><ArrowUpLeft size={16} aria-hidden="true" />فتح حساب المريض واختيار فاتورة أو هدف تحصيل صريح</a>
      <p className={styles.note}>الفواتير الأخرى ليست مرتبطة بالزيارة تلقائيًا. الفاتورة والتحصيل من الحساب وفق الصلاحية.</p>
      <p className={styles.debtNote}>إنهاء المتابعة أو تأجيلها لا يسدّد أي دين، ولا يضيف توقيعًا سريريًا.</p>
      {verified.item.status !== "pending" && !verified.item.financialReviewRequired ? <p role="status">{verified.item.status === "deferred" ? "أُجّلت المتابعة" : "تمت معالجة المتابعة"}: {verified.item.handledReason}. يُحفظ القرار الأول ما دام استحقاق الزيارة لم يتغيّر.</p>
        : <>
          {verified.item.handledReason && <p role="status">{verified.item.handledReason}</p>}
          <label className={styles.reason}>سبب المعالجة أو التأجيل
            <input maxLength={300} value={reason} onChange={event => setReason(event.target.value)} placeholder="اكتب سبب القرار (٣–٣٠٠ حرف)" />
          </label>
          <div className={styles.decisions}><button type="button" disabled={reason.trim().length < 3} onClick={() => { void decide("handled"); }} className={styles.primary}>تمت مراجعة الخروج — لا يثبت السداد</button>
          <button type="button" disabled={reason.trim().length < 3} onClick={() => { void decide("deferred"); }} className={styles.button}>تأجيل المتابعة مع بقاء الرصيد</button></div>
        </>}
    </>}
    {state === "saving" && <p role="status">جارٍ حفظ القرار…</p>}
  </section>;
}
