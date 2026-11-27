"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CURRENCIES } from "@/lib/money";

/**
 * وردية الاستقبال المعزولة (§15):
 * تقتصر على فتح الوردية وإغلاقها بالجرد الأعمى وتحويل الموظف لدليل المرضى للتحصيل.
 * لا تعرض إجماليات الإيراد ولا المتوقع في الصندوق ولا أي مصروفات أو سندات صرف.
 */
export function ReceptionShift() {
  const [shift, setShift] = useState<number | null>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/shifts", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const state = await response.json();
        if (!controller.signal.aborted) setShift(state.open?.id ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage("تعذّر التحقق من حالة الوردية.");
      });
    return () => controller.abort();
  }, [version]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || shift === undefined) return;
    const values = new FormData(event.currentTarget);
    const amounts = Object.fromEntries(CURRENCIES.map((currency) => [currency, values.get(currency)]));
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/shifts", {
        method: shift ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          shift ? { id: shift, counted: amounts, differenceReason: values.get("reason") } : { opening: amounts },
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.message ?? "تعذّر تنفيذ العملية.");
        return;
      }
      setShift(shift ? null : data.id);
      setMessage(shift ? "أُغلقت الوردية بنجاح." : "فُتحت الوردية بنجاح.");
    } catch {
      setShift(undefined);
      setMessage("تعذّر تأكيد النتيجة. تحقّق من حالة الوردية.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main dir="rtl" className="mx-auto max-w-lg space-y-4 p-4">
      <h1 className="text-xl font-bold">وردية الاستقبال</h1>
      <p className="text-sm text-slate-600">
        التحصيل الفردي للمرضى متاح من ملف كل مريض؛ إجماليات العيادة والمصروفات مخصّصة للإدارة والمحاسبة.
      </p>
      <a href="/patients" className="inline-block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold underline">
        اختيار مريض للتحصيل
      </a>
      {shift === undefined ? (
        <button onClick={() => setVersion((v) => v + 1)} className="block rounded border px-3 py-2 text-sm font-bold">
          تحديث حالة الوردية
        </button>
      ) : (
        <form key={shift ?? "new"} onSubmit={submit} className="space-y-3 rounded-xl border bg-white p-4">
          <h2 className="font-bold">{shift ? "المبلغ المعدود عند الإغلاق (جرد أعمى)" : "الرصيد الافتتاحي للدرج"}</h2>
          {CURRENCIES.map((currency) => (
            <label key={currency} className="block text-sm font-medium">
              {currency}
              <input name={currency} inputMode="decimal" defaultValue="0" required className="mx-2 rounded border p-1" />
            </label>
          ))}
          {shift ? (
            <label className="block text-sm font-medium">
              سبب فرق الجرد إن وجد
              <input name="reason" maxLength={300} className="mx-2 rounded border p-1" />
            </label>
          ) : null}
          <button disabled={busy} className="rounded-lg border bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {shift ? "إقفال الوردية" : "فتح الوردية"}
          </button>
        </form>
      )}
      {message ? <p role="status" className="text-sm font-semibold text-slate-700">{message}</p> : null}
    </main>
  );
}
