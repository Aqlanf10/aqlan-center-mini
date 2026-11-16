"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { formatMoney, isCurrency } from "@/lib/money";

/**
 * أسعار خدمات المختبرات للجلسة الموحّدة (M2 slice 70b).
 *
 * قرار المالك: أسعار التكلفة لا يراها إلا من يملك finance.cost-prices.view — الخادم يرفض
 * القراءة لغيره ولا يعيد المبالغ في ردود الكتابة؛ هذه الصفحة لا تطلب الجدول أصلًا بلا
 * الصلاحية. من يملك finance.lab-prices.edit يضيف قاعدة سعر ويعدّلها ويحذفها.
 */
interface Rule { id: number; partyName?: string; serviceName?: string; labServiceId: number; partyId: number; costMinor?: number; costCurrency?: string; effectiveFrom: string; effectiveTo: string | null; note: string | null }
interface Option { id: number; name: string }

export function CanonicalLabPricingPage() {
  const session = useSession();
  const holds = (capability: string) => session?.isOwner === true || (session?.capabilities ?? []).includes(capability);
  const canSee = holds("finance.cost-prices.view"), canEdit = holds("finance.lab-prices.edit");
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [labs, setLabs] = useState<Option[]>([]);
  const [services, setServices] = useState<Option[]>([]);
  const [form, setForm] = useState({ partyId: "", labServiceId: "", cost: "", currency: "YER", effectiveFrom: "", closePrevious: true });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setMessage(null);
    try {
      const [labsResponse, servicesResponse] = await Promise.all([fetch("/api/laboratories", { cache: "no-store" }), fetch("/api/lab/services", { cache: "no-store" })]);
      const labsPayload = await labsResponse.json().catch(() => null), servicesPayload = await servicesResponse.json().catch(() => null);
      if (current !== sequence.current) return;
      setLabs(Array.isArray(labsPayload?.laboratories) ? labsPayload.laboratories : []);
      setServices(Array.isArray(servicesPayload?.services) ? servicesPayload.services : []);
      if (!canSee) return;
      setRules(null);
      const response = await fetch("/api/lab/pricing", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (current !== sequence.current) return;
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر تحميل الأسعار."); return; }
      setRules(payload.rules as Rule[]);
    } catch { if (current === sequence.current) setMessage("تعذّر الاتصال بالخادم."); }
  }, [canSee]);
  useEffect(() => { const first = setTimeout(() => void load(), 0); return () => clearTimeout(first); }, [load]);

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الحفظ."); return false; }
      setMessage("حُفظ."); void load(); return true;
    } catch { setMessage("تعذّر الاتصال بالخادم."); return false; } finally { setBusy(false); }
  }

  const field = "min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <section dir="rtl" className="mx-auto max-w-4xl space-y-3" data-testid="canonical-lab-pricing" aria-labelledby="pricing-title">
      <h1 id="pricing-title" className="text-lg font-black text-navy-900">أسعار خدمات المختبرات</h1>
      {canEdit ? (
        <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2" data-testid="pricing-form">
          <label className="text-xs">المختبر
            <select className={field} value={form.partyId} onChange={event => setForm({ ...form, partyId: event.target.value })} data-testid="pricing-lab">
              <option value="">اختر</option>{labs.map(lab => <option key={lab.id} value={lab.id}>{lab.name}</option>)}
            </select>
          </label>
          <label className="text-xs">الخدمة
            <select className={field} value={form.labServiceId} onChange={event => setForm({ ...form, labServiceId: event.target.value })} data-testid="pricing-service">
              <option value="">اختر</option>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
            </select>
          </label>
          <label className="text-xs">السعر
            <input className={field} dir="ltr" inputMode="decimal" value={form.cost} onChange={event => setForm({ ...form, cost: event.target.value })} data-testid="pricing-cost" />
          </label>
          <label className="text-xs">العملة
            <select className={field} value={form.currency} onChange={event => setForm({ ...form, currency: event.target.value })}>
              {["YER", "SAR", "USD"].map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="text-xs">يسري من
            <input type="date" dir="ltr" className={field} value={form.effectiveFrom} onChange={event => setForm({ ...form, effectiveFrom: event.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={form.closePrevious} onChange={event => setForm({ ...form, closePrevious: event.target.checked })} /> إغلاق السعر السابق لهذه الخدمة
          </label>
          <button type="button" disabled={busy || !form.partyId || !form.labServiceId || !form.cost} data-testid="pricing-save"
            onClick={() => void send("/api/lab/pricing", "POST", { partyId: Number(form.partyId), labServiceId: Number(form.labServiceId), cost: form.cost, costCurrency: form.currency,
              ...(form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}), closePreviousRule: form.closePrevious }).then(ok => { if (ok) setForm({ ...form, cost: "" }); })}
            className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50 sm:col-span-2">إضافة السعر</button>
        </div>
      ) : null}
      {message ? <p role="status" className="text-sm text-navy-800">{message}</p> : null}
      {!canSee ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="pricing-hidden">أسعار التكلفة لا تظهر إلا لمن يملك صلاحية رؤية التكلفة.</p>
      ) : rules ? (
        <ul className="space-y-2" data-testid="pricing-list">
          {rules.map(rule => (
            <li key={rule.id} data-rule={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <span><span className="font-bold text-navy-900">{rule.partyName}</span> · {rule.serviceName}</span>
              <span dir="ltr" className="text-xs">{rule.effectiveFrom}{rule.effectiveTo ? ` → ${rule.effectiveTo}` : " →"}</span>
              <span className="font-bold">{rule.costMinor != null && rule.costCurrency && isCurrency(rule.costCurrency) ? formatMoney(rule.costMinor, rule.costCurrency) : "—"}</span>
              {canEdit ? <button type="button" disabled={busy} onClick={() => void send(`/api/lab/pricing/${rule.id}`, "DELETE")} className="min-h-10 rounded-xl border border-red-300 px-3 text-xs font-bold text-red-800">حذف</button> : null}
            </li>
          ))}
        </ul>
      ) : <p role="status" className="text-sm text-slate-600">جارٍ التحميل…</p>}
    </section>
  );
}
