"use client";
import { useCallback, useEffect, useState } from "react";

type Row = { serviceId: number; name: string; category: string | null; rateBp: number | null; revision: string | null };
const endpoint = "/api/settings/material-service-rates";
const percentage = (bp: number) => String(bp / 100);

function parsePercent(raw: string): number | null {
  const text = raw.trim().replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0)).replace(/[٫,]/g, ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || Number(text) > 100) return null;
  return Math.round(Number(text) * 100);
}

export function ServiceMaterialRates() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [id, setId] = useState(0);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const row = rows?.find(r => r.serviceId === id);

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (!res.ok) {
        if (res.status !== 401 && res.status !== 403) setMessage("تعذّر تحميل نسب الخدمات.");
        return;
      }
      const result = await res.json() as { enabled: boolean; rates: Row[] };
      if (result.enabled) setRows(result.rates);
    } catch { setMessage("تعذّر الاتصال بإعدادات نسب الخدمات."); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(inherit = false) {
    if (!row || busy) return;
    const rateBp = inherit ? null : parsePercent(value);
    if (!inherit && rateBp === null) { setMessage("أدخل نسبة من ٠ إلى ١٠٠."); return; }
    if (reason.trim().length < 3) { setMessage("اكتب سبب التغيير."); return; }
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: row.serviceId, revision: row.revision, rateBp, reason }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409) { setId(0); setValue(""); await load(); }
      if (!res.ok) { setMessage(data?.message ?? "تعذّر حفظ نسبة الخدمة."); return; }
      setReason("");
      if (inherit) setValue("");
      await load();
      setMessage(inherit ? "تُستخدم نسبة الفئة لهذه الخدمة من الآن." : "حُفظت نسبة الخدمة من الآن.");
    } catch { setMessage("تعذّر الاتصال بالخادم؛ حدّث الصفحة قبل المحاولة."); }
    finally { setBusy(false); }
  }

  if (!loaded || !rows) return message ? <p role="status">{message}</p> : null;
  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="service-material-rates">
      <h2 id="service-material-rates" className="font-bold text-slate-900">إهلاك المواد لكل خدمة</h2>
      <p className="mb-3 text-sm text-slate-600">النسبة تُحسب بعد خصم المختبر عند تفعيل خصمه. صفر يعفي الخدمة، والرجوع إلى نسبة الفئة يلغي تخصيصها للمستقبل.</p>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block text-sm">الخدمة
          <select className="mt-1 block w-full rounded-lg border p-2" disabled={busy} value={id}
            onChange={e => {
              const next = Number(e.target.value);
              const picked = rows.find(item => item.serviceId === next);
              setId(next);
              setValue(picked?.rateBp == null ? "" : percentage(picked.rateBp));
              setReason(""); setMessage("");
            }}>
            <option value={0}>اختر خدمة</option>
            {rows.map(item => <option key={item.serviceId} value={item.serviceId}>{item.name}{item.category ? ` · ${item.category}` : ""}</option>)}
          </select>
        </label>
        {row && <>
          <p className="text-sm text-slate-600">الحالي: {row.rateBp === null ? "نسبة الفئة" : `${percentage(row.rateBp)}%`}</p>
          <label className="block text-sm">النسبة المئوية
            <input className="mt-1 block w-full rounded-lg border p-2" dir="ltr" inputMode="decimal" maxLength={6} value={value} onChange={e => setValue(e.target.value)} disabled={busy} />
          </label>
          <label className="block text-sm">سبب التغيير
            <input className="mt-1 block w-full rounded-lg border p-2" maxLength={300} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} required />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">حفظ النسبة</button>
            <button type="button" disabled={busy || row.rateBp === null} onClick={() => void save(true)} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">استخدام نسبة الفئة</button>
          </div>
        </>}
      </form>
      {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </section>
  );
}
