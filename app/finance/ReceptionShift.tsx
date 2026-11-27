"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ShiftExpenseForm, type PartyItem } from "@/components/finance/CashShiftTab";
import { CURRENCIES } from "@/lib/money";

export function ReceptionShift() {
  const [shift, setShift] = useState<number | null>();
  const [expense, setExpense] = useState(false);
  const [parties, setParties] = useState<PartyItem[]>([]);
  const [voucher, setVoucher] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/shifts", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (!controller.signal.aborted) setShift(state.open?.id ?? null);
    }).catch(() => { if (!controller.signal.aborted) setMessage("تعذّر التحقق من حالة الوردية."); });
    return () => controller.abort();
  }, [version]);

  useEffect(() => {
    if (!expense) return;
    const controller = new AbortController();
    fetch("/api/parties", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const items = await response.json();
      if (!controller.signal.aborted) setParties(items);
    }).catch(() => { if (!controller.signal.aborted) setMessage("تعذّر تحميل الجهات."); });
    return () => controller.abort();
  }, [expense]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || shift === undefined) return;
    const values = new FormData(event.currentTarget);
    const amounts = Object.fromEntries(CURRENCIES.map(currency => [currency, values.get(currency)]));
    setBusy(true);
    try {
      const response = await fetch("/api/shifts", { method: shift ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shift ? { id: shift, counted: amounts, differenceReason: values.get("reason") } : { opening: amounts }),
      });
      const data = await response.json();
      if (!response.ok) { setMessage(data.message ?? "تعذّر تنفيذ العملية."); return; }
      setExpense(false);
      setShift(shift ? null : data.id);
      setMessage(shift ? "أُغلقت الوردية." : "فُتحت الوردية.");
    } catch {
      setShift(undefined);
      setMessage("تعذّر تأكيد النتيجة. تحقّق من حالة الوردية.");
    } finally { setBusy(false); }
  }
  return <main dir="rtl" className="mx-auto max-w-lg space-y-4 p-4">
    <h1 className="text-xl font-bold">وردية الاستقبال</h1>
    <a href="/patients" className="underline">اختيار مريض للتحصيل</a>
    {shift === undefined ? <button onClick={() => setVersion(v => v + 1)}>تحديث حالة الوردية</button> :
      <form key={shift ?? "new"} onSubmit={submit} className="space-y-3 rounded-xl border p-4">
        <h2>{shift ? "المبلغ المعدود عند الإغلاق" : "الرصيد الافتتاحي"}</h2>
        {CURRENCIES.map(currency => <label key={currency} className="block">{currency}
          <input name={currency} inputMode="decimal" defaultValue="0" required className="mx-2 rounded border p-1" />
        </label>)}
        {shift && <label className="block">سبب فرق الجرد إن وجد <input name="reason" maxLength={300} className="rounded border p-1" /></label>}
        <button disabled={busy} className="rounded border px-3 py-2">{shift ? "إقفال الوردية" : "فتح الوردية"}</button>
      </form>}
    {shift && !expense && <button className="rounded border p-2" onClick={() => setExpense(true)}>إصدار سند صرف</button>}
    {shift && expense && <ShiftExpenseForm parties={parties} baseCurrency="YER" isAdmin={false}
      busy={busy} onCancel={() => setExpense(false)} onCreateExpense={async form => {
        if (busy) return;
        setBusy(true);
        try {
          const response = await fetch("/api/expenses", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(form) });
          const data = await response.json();
          if (!response.ok) { setMessage(data.message ?? "تعذّر إصدار السند."); return; }
          setVoucher(data.id); setExpense(false); setMessage("صدر سند الصرف.");
          return data.id;
        } catch { setMessage("تعذّر تأكيد إصدار السند. تحقّق قبل تكرار الصرف."); }
        finally { setBusy(false); }
      }} />}
    {voucher && <a className="block underline" target="_blank" rel="noopener" href={`/print/voucher/${voucher}`}>طباعة سند الصرف</a>}
    {message && <p role="status">{message}</p>}
  </main>;
}
