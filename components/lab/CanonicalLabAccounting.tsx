"use client";

import { useState } from "react";
import type { LabOrderClinicalDTO } from "@/lib/lab";

/**
 * الربط المحاسبي لأمر المختبر في اللوحة الموحّدة (M2 slice 71) — لمن يملك
 * finance.payables.record. ترحيل وإلغاء ترحيل وتسجيل التكلفة بعملتها؛ سعر الصرف من
 * الإعدادات في الخادم. حراسات السداد والفترة المقفلة والربط تبقى في الخادم وتُعرض
 * رسائلها. لا تُعرض المبالغ هنا (قاعدة المالك): من يملك رؤية التكلفة يراها في البطاقة.
 */
export function CanonicalLabAccounting({ order, onChanged }: { order: LabOrderClinicalDTO; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("YER");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/lab/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الحفظ."); return; }
      setMessage(payload?.outcome === "unchanged" ? "لا تغيير." : "حُفظ.");
      setCost(""); onChanged();
    } catch { setMessage("تعذّر الاتصال بالخادم."); } finally { setBusy(false); }
  }

  if (order.status === "cancelled") return null;
  return (
    <div className="mt-2" data-testid="lab-accounting">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs font-bold text-emerald-800 underline-offset-2 hover:underline">الربط المحاسبي</button>
      {open ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 p-2 text-xs">
          <button type="button" disabled={busy} onClick={() => void send({ action: "post" })} data-testid="acct-post" className="min-h-10 rounded-xl bg-emerald-800 px-3 font-bold text-white disabled:opacity-50">ترحيل</button>
          <button type="button" disabled={busy} onClick={() => void send({ action: "unpost" })} data-testid="acct-unpost" className="min-h-10 rounded-xl border border-slate-300 px-3 font-bold disabled:opacity-50">إلغاء الترحيل</button>
          <label className="flex items-center gap-1">التكلفة
            <input dir="ltr" inputMode="decimal" value={cost} onChange={event => setCost(event.target.value)} data-testid="acct-cost" className="min-h-10 w-24 rounded-xl border border-slate-300 px-2" />
          </label>
          <select value={currency} onChange={event => setCurrency(event.target.value)} className="min-h-10 rounded-xl border border-slate-300 px-2">
            {["YER", "SAR", "USD"].map(code => <option key={code} value={code}>{code}</option>)}
          </select>
          <button type="button" disabled={busy || !cost.trim()} onClick={() => void send({ action: "update_accounting", cost: cost.trim(), costCurrency: currency })} data-testid="acct-save"
            className="min-h-10 rounded-xl border border-slate-300 px-3 font-bold disabled:opacity-50">حفظ التكلفة</button>
          {message ? <p role="status" className="w-full text-xs text-navy-800">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
