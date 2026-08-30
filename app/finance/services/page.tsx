"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { CATEGORY_LABEL, CHART_CATEGORIES } from "@/lib/services-catalog";
import { useSetting } from "@/components/SettingsProvider";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * قائمة الأسعار.
 *
 * وجودها يغيّر شكل الفوترة كلها: بلا قائمة تُكتب المبالغ من الذاكرة، فيختلف سعر
 * الحشوة بين موظفة وأخرى وبين يوم وآخر، ولا يستطيع أي تقرير أن يقول ماذا يدرّ كل نوع
 * علاج. ومع القائمة يبقى التعديل ممكنًا لكل حالة — السعر اقتراحٌ لا قيد.
 */

interface Service {
  id: number; name: string; category: string | null;
  priceMinor: number; isActive: boolean; sortOrder: number;
}

export default function ServicesPage() {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/services?all=1", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setServices(payload as Service[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await send(() => fetch("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, price }),
    }));
    if (ok) { setName(""); setPrice(""); }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const service of services) {
      const key = service.category ?? "بلا تصنيف";
      map.set(key, [...(map.get(key) ?? []), service]);
    }
    return [...map.entries()];
  }, [services]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="قائمة الأسعار"
        subtitle="السعر اقتراحٌ لا قيد — يمكن تعديله في كل فاتورة"
        links={financeLinks("/finance/services")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <form onSubmit={add} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">خدمة جديدة</h2>
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم الخدمة"
            aria-label="اسم الخدمة"
            className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="التصنيف"
            aria-label="التصنيف" list="categories"
            className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          <datalist id="categories">
            {/* التصنيفات المعيارية أولًا: هي التي تُحدّث المخطط السني وتُجمّع التقارير
                — والتصنيفات الحرة القديمة تبقى ظاهرة لأنها مستعملة في فواتير سابقة. */}
            {CHART_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            {Object.keys(CATEGORY_LABEL)
              .filter((c) => !(CHART_CATEGORIES as readonly string[]).includes(c))
              .map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            {[...new Set(services.map((s) => s.category).filter(Boolean))]
              .filter((c): c is string => c !== null && !(c in CATEGORY_LABEL))
              .map((c) => <option key={c} value={c} />)}
          </datalist>
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="السعر"
            aria-label="السعر" inputMode="decimal" dir="ltr"
            className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          <button type="submit" disabled={busy || !name.trim() || !price.trim()}
            className="rounded-xl bg-brand-orange px-5 py-2 text-sm font-bold text-white disabled:opacity-50">
            أضف
          </button>
        </div>
      </form>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : services.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا خدمات معروضة — أضف من النموذج أعلاه ما تعمله العيادة أكثر.
        </p>
      ) : (
        grouped.map(([groupName, list]) => (
          <section key={groupName} className="mb-4">
            <h2 className="mb-2 text-sm font-bold">
              {CATEGORY_LABEL[groupName] ?? groupName}
              {(CHART_CATEGORIES as readonly string[]).includes(groupName) ? (
                <span className="mr-1.5 text-[10px] font-semibold text-slate-400">يُحدّث المخطط السني</span>
              ) : null}
            </h2>
            <ul className="space-y-2">
              {list.map((service) => (
                <li key={service.id} className={`rounded-2xl border p-3 ${service.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-[8rem] flex-1 truncate text-sm font-extrabold">{service.name}</span>
                    {editingId === service.id ? (
                      <>
                        <input value={editPrice} onChange={(e) => setEditPrice(e.target.value)}
                          inputMode="decimal" dir="ltr" autoFocus
                          className="w-28 rounded-xl border border-slate-200 px-3 py-1.5 text-sm" />
                        <button
                          onClick={async () => {
                            const ok = await send(() => fetch(`/api/services/${service.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ price: editPrice }),
                            }));
                            if (ok) setEditingId(null);
                          }}
                          disabled={busy}
                          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">
                          حفظ
                        </button>
                        <button onClick={() => setEditingId(null)}
                          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
                          إلغاء
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-bold">{formatMoney(service.priceMinor, base)}</span>
                        <button
                          onClick={() => { setEditingId(service.id); setEditPrice(formatAmount(service.priceMinor, base).replace(/,/g, "")); }}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                          تعديل السعر
                        </button>
                        <button
                          onClick={() => send(() => fetch(`/api/services/${service.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ isActive: !service.isActive }),
                          }))}
                          disabled={busy}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 disabled:opacity-40">
                          {service.isActive ? "إيقاف" : "تفعيل"}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {/* الخدمة تُوقَف ولا تُحذف: حذفها يكسر فواتير قديمة تشير إليها، ويجعل تقرير
          العام الماضي يفقد بنودًا كانت فيه. */}
      <p className="mt-4 text-center text-[11px] text-slate-400">
        الخدمة تُوقَف ولا تُحذف — الفواتير القديمة تشير إليها.
      </p>
    </main>
  );
}
