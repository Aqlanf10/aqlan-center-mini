"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * ربط الخدمات بالمستهلكات (المواصفة §٢٠) — «ماذا يستهلك كل إجراء؟».
 *
 * الحشوة تستهلك أمالغم ومخدّرًا وقفازين — والتعريف هنا مرة واحدة، ثم يخصم النظام
 * تلقائيًا عند توقيع كل زيارة فيدخل المستهلك في سجل المريض مرتبطًا بزيارته.
 * ومن هنا يُعدَّل الرقم أو يُحذف الربط: التعريف للإدارة، والخصم للرحلة.
 */

interface ServiceRow { id: number; name: string; category: string | null; priceMinor: number; isActive: boolean }
interface ItemRow { id: number; name: string; unit: string; category: string; isActive: boolean }
interface Mapping {
  id: number; serviceId: number; serviceName: string;
  itemId: number; itemName: string; unit: string;
  qtyPerUnit: number; note: string | null; createdBy: string;
}

export default function ServiceMaterialsPage() {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ serviceId: "", itemId: "", qtyPerUnit: "1" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mappingRes, serviceRes, itemRes] = await Promise.all([
        fetch("/api/service-materials", { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/inventory", { cache: "no-store" }),
      ]);
      const mappingPayload = await mappingRes.json();
      if (!mappingRes.ok) throw new Error(mappingPayload?.message ?? "تعذّر تحميل الربط.");
      setMappings(mappingPayload as Mapping[]);
      if (serviceRes.ok) setServices(await serviceRes.json());
      if (itemRes.ok) {
        const payload = await itemRes.json();
        setItems((payload.items ?? payload ?? []) as ItemRow[]);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/service-materials", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: Number(form.serviceId),
          itemId: Number(form.itemId),
          qtyPerUnit: Number(form.qtyPerUnit),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر حفظ الربط.");
        return;
      }
      setForm({ serviceId: "", itemId: "", qtyPerUnit: "1" });
      setMessage("حُفظ الربط — سيُخصم تلقائيًا عند توقيع كل زيارة تنفّذ هذه الخدمة.");
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/service-materials?id=${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر حذف الربط.");
        return;
      }
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">ربط الخدمات بالمستهلكات</h1>
        <p className="text-xs text-slate-500">
          عرّف ماذا تستهلك كل خدمة — والنظام يخصمه تلقائيًا عند توقيع الزيارة
        </p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {message ? (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">{message}</p>
      ) : null}

      <form onSubmit={add} className="mb-4 rounded-2xl border border-brand-blue bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">ربط جديد</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-[11px] font-bold text-slate-600">
            الخدمة (من الدليل)
            <select value={form.serviceId} required
              onChange={(event) => setForm((current) => ({ ...current, serviceId: event.target.value }))}
              className="mt-1 block w-full rounded-xl border border-slate-200 px-2 py-2 text-xs">
              <option value="">— اختر الخدمة —</option>
              {services.filter((service) => service.isActive).map((service) => (
                <option key={service.id} value={service.id}>{service.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-bold text-slate-600">
            المادة (من المخزون)
            <select value={form.itemId} required
              onChange={(event) => setForm((current) => ({ ...current, itemId: event.target.value }))}
              className="mt-1 block w-full rounded-xl border border-slate-200 px-2 py-2 text-xs">
              <option value="">— اختر المادة —</option>
              {items.filter((item) => item.isActive).map((item) => (
                <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-bold text-slate-600">
            الكمية لكل وحدة
            <input value={form.qtyPerUnit} required inputMode="decimal" dir="ltr"
              onChange={(event) => setForm((current) => ({ ...current, qtyPerUnit: event.target.value }))}
              className="mt-1 block w-full rounded-xl border border-slate-200 px-2 py-2 text-xs"
              aria-label="الكمية لكل وحدة" />
          </label>
        </div>
        <button type="submit" disabled={busy || !form.serviceId || !form.itemId}
          className="mt-3 w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
          {busy ? "جارٍ الحفظ…" : "احفظ الربط"}
        </button>
      </form>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : mappings.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
          لا روابط بعد — عرّف أول ربط أعلاه وسيبدأ الخصم التلقائي.
        </p>
      ) : (
        <ul className="space-y-2">
          {mappings.map((mapping) => (
            <li key={mapping.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-navy-900">
                  {mapping.serviceName}
                  <span className="mx-1 text-slate-400">←</span>
                  <span className="text-sky-800">{mapping.itemName}</span>
                </p>
                <p className="text-[11px] text-slate-500">
                  {mapping.qtyPerUnit} {mapping.unit} لكل وحدة منفَّذة
                  {mapping.note ? ` · ${mapping.note}` : ""}
                </p>
              </div>
              <button type="button" onClick={() => void remove(mapping.id)} disabled={busy}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-danger-700 hover:bg-danger-50 disabled:opacity-40">
                احذف الربط
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
        الخصم يقع داخل معاملة توقيع الزيارة نفسها: إما الزيارة بكل آثارها أو لا شيء —
        فلا زيارة موقَّعة بلا مستهلكاتها، ولا مستهلكات بلا زيارة.
      </p>
    </main>
  );
}
