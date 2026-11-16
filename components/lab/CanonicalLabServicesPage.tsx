"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { LAB_SERVICE_CATEGORY_META, LAB_TOOTH_SCOPE_META, type LabService } from "@/lib/lab";

/**
 * دليل خدمات المختبر للجلسة الموحّدة (M2 slice 70b): العرض لمن يملك clinical.lab.view،
 * والإضافة والتعديل والتعطيل والبذر لمن يملك finance.lab-prices.edit. لا أسعار هنا.
 */
export function CanonicalLabServicesPage() {
  const session = useSession();
  const canEdit = session?.isOwner === true || (session?.capabilities ?? []).includes("finance.lab-prices.edit");
  const [services, setServices] = useState<LabService[] | null>(null);
  const [draft, setDraft] = useState({ name: "", code: "", category: "prostho", toothScope: "single_tooth", defaultDays: "7" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const response = await fetch("/api/lab/services?all=1", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (current !== sequence.current) return;
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر تحميل الدليل."); return; }
      setServices(payload.services as LabService[]);
    } catch { if (current === sequence.current) setMessage("تعذّر الاتصال بالخادم."); }
  }, []);
  useEffect(() => { const first = setTimeout(() => void load(), 0); return () => clearTimeout(first); }, [load]);

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      setMessage(response.ok ? (payload?.message ?? "حُفظ.") : (payload?.message ?? "تعذّر الحفظ."));
      if (response.ok) void load();
      return response.ok;
    } catch { setMessage("تعذّر الاتصال بالخادم."); return false; } finally { setBusy(false); }
  }

  const field = "min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <section dir="rtl" className="mx-auto max-w-4xl space-y-3" data-testid="canonical-lab-services" aria-labelledby="services-title">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <h1 id="services-title" className="text-lg font-black text-navy-900">دليل خدمات المختبر</h1>
        {canEdit ? <button type="button" disabled={busy} onClick={() => void send("/api/lab/services", "POST", { action: "seed_defaults" })} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold">تحديث الدليل القياسي</button> : null}
      </header>
      {canEdit ? (
        <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2" data-testid="service-form">
          <label className="text-xs">الاسم<input className={field} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} data-testid="service-name" /></label>
          <label className="text-xs">الرمز<input className={field} dir="ltr" value={draft.code} onChange={event => setDraft({ ...draft, code: event.target.value })} data-testid="service-code" /></label>
          <label className="text-xs">التصنيف
            <select className={field} value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>
              {Object.entries(LAB_SERVICE_CATEGORY_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </label>
          <label className="text-xs">نطاق الأسنان
            <select className={field} value={draft.toothScope} onChange={event => setDraft({ ...draft, toothScope: event.target.value })}>
              {Object.entries(LAB_TOOTH_SCOPE_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </label>
          <label className="text-xs">المدة الافتراضية (أيام)<input className={field} inputMode="numeric" value={draft.defaultDays} onChange={event => setDraft({ ...draft, defaultDays: event.target.value })} /></label>
          <button type="button" disabled={busy || !draft.name.trim()} data-testid="service-save"
            onClick={() => void send("/api/lab/services", "POST", { ...draft, defaultDays: Number(draft.defaultDays) }).then(ok => { if (ok) setDraft({ ...draft, name: "", code: "" }); })}
            className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">إضافة الخدمة</button>
        </div>
      ) : null}
      {message ? <p role="status" className="text-sm text-navy-800">{message}</p> : null}
      {services ? (
        <ul className="space-y-2" data-testid="service-list">
          {services.map(service => (
            <li key={service.id} data-service={service.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm ${service.isActive ? "" : "opacity-70"}`}>
              <span><span className="font-bold text-navy-900">{service.name}</span>{service.code ? <span dir="ltr" className="mr-2 text-xs text-slate-600">{service.code}</span> : null}{service.isActive ? null : <span className="mr-2 text-xs">(معطّلة)</span>}</span>
              <span className="text-xs text-slate-600">{LAB_SERVICE_CATEGORY_META[service.category]?.label} · {service.defaultDays} أيام · طلبات {service.totalOrdersCount}</span>
              {canEdit ? (service.isActive
                ? <button type="button" disabled={busy} onClick={() => void send(`/api/lab/services/${service.id}`, "DELETE")} data-testid="service-delete" className="min-h-10 rounded-xl border border-red-300 px-3 text-xs font-bold text-red-800">{service.totalOrdersCount ? "تعطيل" : "حذف"}</button>
                : <button type="button" disabled={busy} onClick={() => void send(`/api/lab/services/${service.id}`, "PATCH", { isActive: true })} className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold">إعادة التفعيل</button>) : null}
            </li>
          ))}
        </ul>
      ) : <p role="status" className="text-sm text-slate-600">جارٍ التحميل…</p>}
    </section>
  );
}
