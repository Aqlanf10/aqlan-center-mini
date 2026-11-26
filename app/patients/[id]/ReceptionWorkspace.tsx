"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { readReceptionPatientAccount } from "@/lib/reception-patient-account";
import { PatientLedger } from "@/components/PatientLedger";
import { CollectPaymentModal } from "@/components/CollectPaymentModal";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";
import { PatientAppointmentsPanel } from "@/components/patient/PatientAppointmentsPanel";
import { TodayVisitTab } from "@/components/patient/TodayVisitTab";
import type { CheckoutVisitRequest } from "@/lib/checkout-visit-request";
import { CLINIC_BASE_CURRENCY, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";

type Card = { id: number; fullName: string; phone: string | null; patientNumber: string };
type Money = Awaited<ReturnType<typeof readReceptionPatientAccount>> & {canCollect:boolean};
const action = "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold";
const panel = "space-y-3 rounded-2xl border border-slate-200 bg-white p-4";

function useReceptionRead<T extends { id: number }>(id: number, projection: string, version: number) {
  const [result, setResult] = useState<{ version: number; data?: T; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/patients/${id}?projection=${projection}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const data: T = await response.json();
        if (data?.id !== id) throw new Error();
        if (!controller.signal.aborted) setResult({ version, data });
      } catch {
        if (!controller.signal.aborted) setResult({ version, error: "تعذّر التحقق من البيانات." });
      }
    }
    void load();
    return () => controller.abort();
  }, [id, projection, version]);
  return result?.version === version ? result : undefined;
}

function ExternalUpload({ id }: { id: number }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/patients/${id}/documents`, { method: "POST", body: new FormData(form) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setNotice(body?.message ?? "تعذّر رفع المستند.");
        return;
      }
      form.reset();
      setNotice("رُفع المستند إلى ملف المريض.");
    } catch {
      setNotice("تعذّر تأكيد الرفع. تحقق قبل تكرار المحاولة.");
    } finally { setBusy(false); }
  }
  return <form className={panel} onSubmit={submit}>
    <h2 className="font-bold">رفع مستند خارجي</h2>
    <label className="block">النوع <select name="kind" className={action}>
      <option value="xray">أشعة خارجية</option><option value="report">تقرير خارجي</option><option value="other">مستند آخر</option>
    </select></label>
    <label className="block">الملف <input required type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
    <button className={action} disabled={busy}>{busy ? "جارٍ الرفع…" : "رفع المستند"}</button>
    {notice && <p role="status">{notice}</p>}
  </form>;
}

function PatientMoney({ patient, checkout }: { patient: Card; checkout: CheckoutVisitRequest }) {
  const [version, setVersion] = useState(0);
  const [choice, setChoice] = useState("");
  const [receipt, setReceipt] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const response = useReceptionRead<Money>(patient.id, "reception-money", version);
  const money = response?.data;
  function refresh() { setOpen(false); setChoice(""); setVersion(value => value + 1); }
  if (!money) return <section className={panel} aria-label="الرصيد الفردي">
    {response?.error ? <><p role="alert">تعذّر التحقق من الرصيد.</p><button className={action} onClick={refresh}>إعادة تحميل الرصيد</button></> : "جارٍ تحميل الرصيد…"}
  </section>;
  const invoice = money.targets.invoices.find(item => choice === `invoice-${item.id}`);
  const plan = money.targets.plans.find(item => choice === `plan-${item.id}`);
  const opening = money.targets.openings.find(currency => choice === `opening-${currency}`);
  return <section className={panel} aria-label="الرصيد الفردي">
    <h2 className="font-bold">حساب المريض</h2>
    <div className="grid gap-3 sm:grid-cols-3">{money.balances.map(row => <div key={row.currency} className="rounded-lg bg-slate-50 p-3">
      <strong>{CURRENCY_LABEL[row.currency]}</strong>
      <p>{row.dueMinor < 0 ? "رصيد دائن" : "المتبقي على الحساب"}: {formatMoney(Math.abs(row.dueMinor),row.currency)}</p>
      <p>صافي المدفوع بعملة الحساب: {formatMoney(row.paidMinor,row.currency)}</p>
      <p>المطلوب الآن من ترتيبات السداد: {row.scheduledDueMinor === null ? "يحتاج مراجعة" : formatMoney(row.scheduledDueMinor,row.currency)}</p>
      {row.otherMinor > 0 && <p>رصيد خارج جدول السداد: {formatMoney(row.otherMinor,row.currency)}</p>}
    </div>)}</div>
    {money.agreements.length > 0 && <section><h3 className="font-bold">الاتفاقات والأقساط</h3>{money.agreements.map(a =>
      <p key={a.id}>اتفاق #{a.id} · المتفق عليه {formatMoney(a.totalMinor,a.currency)} · المدفوع {a.paidMinor===null?"غير متحقق":formatMoney(a.paidMinor,a.currency)}
      {" · "}المتبقي {a.remainingMinor===null?"غير متحقق":formatMoney(a.remainingMinor,a.currency)}
      {" · "}قسط الاتفاق المستحق اليوم {a.dueNowMinor===null?"يحتاج مراجعة":formatMoney(a.dueNowMinor,a.currency)}</p>)}</section>}
    {money.history.length > 0 && <section><h3 className="font-bold">الاتفاقات السابقة عند الترحيل</h3>{money.history.map(a =>
      <p key={a.kind+a.id}>{a.historicalAsOf} · المتفق عليه {formatMoney(a.agreedMinor,a.currency)} · المدفوع سابقًا {formatMoney(a.previouslyPaidMinor,a.currency)} · المتبقي وقت الترحيل {formatMoney(a.remainingMinor,a.currency)}</p>)}</section>}
    <details><summary className="cursor-pointer font-bold">الفواتير ({money.invoices.length})</summary>
      {money.invoices.map(i=><p key={i.id}><bdi>{i.number}</bdi> · {i.createdAt.slice(0,10)} · {formatMoney(i.netMinor,i.currency)} · {i.status==="cancelled"?"ملغاة":i.status==="paid"?"مسددة":"مفتوحة"}</p>)}</details>
    <details><summary className="cursor-pointer font-bold">الدفعات والسندات ({money.receipts.length})</summary>
      {money.receipts.map(r=><p key={r.id}>{r.kind==="refund"?"رد مبلغ":"قبض"} · <bdi>{r.number}</bdi> · {r.createdAt.slice(0,10)} · {formatMoney(r.amountMinor,r.currency)}
        {" · "}<a className="underline" href={`/print/receipt/${r.id}?patientId=${patient.id}`} target="_blank" rel="noopener">طباعة السند</a></p>)}</details>
    {receipt && money.receipts.some(r=>r.id===receipt) && <a role="status" className="block underline" target="_blank" rel="noopener"
      href={`/print/receipt/${receipt}?patientId=${patient.id}`}>تم التحصيل · طباعة سند القبض</a>}
    {checkout === null && money.schedules.length > 0 && <PatientLedger patientId={patient.id} receptionSchedules onClinicalChange={refresh} />}
    {checkout === "invalid" ? <p role="alert">رقم زيارة التحصيل غير صالح.</p> : typeof checkout === "number" ?
      <TodayVisitTab key={checkout} patientId={patient.id} patientName={patient.fullName} summary={null} visits={[]}
        base={CLINIC_BASE_CURRENCY} canCollect={money.canCollect} requestedCheckoutVisitId={checkout}
        onVisitStarted={refresh} onChanged={refresh} /> :
      money.canCollect && <>
        <label className="block">تقييد الدفعة <select className={action} value={choice} onChange={e => setChoice(e.target.value)}>
          <option value="">اختر وجهة الدفعة</option>
          <option value="account">على الحساب ({CURRENCY_LABEL[CLINIC_BASE_CURRENCY]})</option>
          {money.targets.invoices.map(item => <option key={item.id} value={`invoice-${item.id}`}>فاتورة #{item.id} · {CURRENCY_LABEL[item.currency]}</option>)}
          {money.targets.plans.map(item => <option key={item.id} value={`plan-${item.id}`}>اتفاق #{item.id} · {CURRENCY_LABEL[item.currency]}</option>)}
          {money.targets.openings.map(currency => <option key={currency} value={`opening-${currency}`}>رصيد سابق · {CURRENCY_LABEL[currency]}</option>)}
        </select></label>
        <button className={action} disabled={!choice} onClick={() => setOpen(true)}>تحصيل دفعة</button>
        <CollectPaymentModal patientId={patient.id} patientName={patient.fullName} isOpen={open}
          onClose={() => setOpen(false)} onSuccess={id => { setReceipt(id); refresh(); }}
          presetInvoice={invoice && { id: invoice.id, baseCurrency: invoice.currency }} presetPlanId={plan?.id}
          presetOpeningCurrency={opening} suggestedCurrency={plan?.currency} suggestedMinor={plan?.dueNowMinor} />
      </>}
  </section>;
}

export function ReceptionWorkspace({ id, checkout }: { id: number; checkout: CheckoutVisitRequest }) {
  const [version, setVersion] = useState(0);
  const [booking, setBooking] = useState(false);
  const [appointmentsVersion, setAppointmentsVersion] = useState(0);
  const response = useReceptionRead<Card>(id, "reception", version);
  const patient = response?.data;
  if (!patient) return <main className={panel}>{response?.error ? <>
    <p role="alert">تعذّر فتح ملف الاستقبال.</p>
    <button className={action} onClick={() => setVersion(value => value + 1)}>إعادة المحاولة</button>
    <a href="/patients">دليل المرضى</a>
  </> : "جارٍ تحميل ملف الاستقبال…"}</main>;
  return <main dir="rtl" className="mx-auto max-w-4xl space-y-4 p-4">
    <header className={panel}>
      <a className="text-sm underline" href="/patients">دليل المرضى والتسجيل</a>
      <h1 className="text-xl font-bold">{patient.fullName}</h1>
      <p>رقم الملف <bdi>{patient.patientNumber}</bdi></p>
      {patient.phone && <p>الهاتف <bdi>{patient.phone}</bdi></p>}
      <button className={action} onClick={() => setBooking(true)}>حجز موعد</button>
    </header>
    <PatientMoney patient={patient} checkout={checkout} />
    <PatientAppointmentsPanel key={appointmentsVersion} patientId={id} />
    <ExternalUpload id={id} />
    {booking && <QuickAppointmentModal patientId={id} patientName={patient.fullName} isOpen onClose={() => setBooking(false)}
      onSuccess={() => { setBooking(false); setAppointmentsVersion(value => value + 1); }} />}
  </main>;
}
