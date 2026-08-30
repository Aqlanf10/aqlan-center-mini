"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import {
  DENTAL_SERVICE_CATEGORIES,
  categoryDisplayName,
  normalizeCategory,
} from "@/components/ServiceSelect";
import { CHART_CATEGORIES } from "@/lib/services-catalog";

interface Service {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
  isActive: boolean;
  sortOrder: number;
}

export default function ServicesPage() {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("filling");
  const [price, setPrice] = useState("");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");
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

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (run: () => Promise<Response>) => {
      if (busy) return false;
      setBusy(true);
      try {
        const response = await run();
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر التنفيذ.");
          return false;
        }
        setError(null);
        await load();
        return true;
      } catch {
        setError("تعذّر الاتصال بالخادم.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await send(() =>
      fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), category: category.trim(), price }),
      }),
    );
    if (ok) {
      setName("");
      setPrice("");
    }
  };

  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      const norm = normalizeCategory(s.category);
      const matchTab = activeTab === "all" || norm === activeTab;
      const matchSearch =
        !search.trim() ||
        s.name.toLowerCase().includes(search.toLowerCase().trim()) ||
        (s.category ?? "").toLowerCase().includes(search.toLowerCase().trim());
      return matchTab && matchSearch;
    });
  }, [services, activeTab, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const service of filteredServices) {
      const norm = normalizeCategory(service.category);
      map.set(norm, [...(map.get(norm) ?? []), service]);
    }
    return [...map.entries()];
  }, [filteredServices]);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="دليل الخدمات وقائمة الأسعار"
        subtitle="دليل موحد ومصنف حسب التخصصات السنية لسهولة التعبئة والفوترة الفورية"
        links={financeLinks("/finance/services")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {/* نموذج إضافة خدمة جديدة */}
      <form onSubmit={add} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <h2 className="mb-1 text-sm font-extrabold text-navy-900">+ إضافة خدمة أو إجراء سنّي جديد</h2>
        <p className="mb-3 text-[11px] text-slate-400">
          الفئات المعيارية (حشوات، علاج جذور، تيجان…) تُحدّث المخطط السني تلقائيًا عند توقيع الزيارة — و«خدمات أخرى» تعمل ماليًّا بلا تحديث للمخطط.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم الخدمة (مثال: حشوة تجميلية كمبوزيت)"
            aria-label="اسم الخدمة"
            required
            className="min-w-[12rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-navy-800"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="التصنيف"
            className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-navy-800"
          >
            {DENTAL_SERVICE_CATEGORIES.filter((c) => c.key !== "all").map((cat) => (
              <option key={cat.key} value={cat.key}>
                {cat.icon} {cat.label}
              </option>
            ))}
            <option value="أخرى">📦 خدمات أخرى</option>
          </select>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="السعر القياسي"
            aria-label="السعر"
            inputMode="decimal"
            dir="ltr"
            required
            className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-navy-800"
          />
          <button
            type="submit"
            disabled={busy || !name.trim() || !price.trim()}
            className="rounded-xl bg-navy-800 px-5 py-2 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            إضافة للدليل
          </button>
        </div>
      </form>

      {/* شريط البحث وفلترة الأقسام */}
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {DENTAL_SERVICE_CATEGORIES.map((cat) => {
              const count =
                cat.key === "all"
                  ? services.length
                  : services.filter((s) => normalizeCategory(s.category) === cat.key).length;
              const isSelected = activeTab === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveTab(cat.key)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                    isSelected
                      ? "bg-navy-800 text-white shadow-xs"
                      : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                  }`}
                >
                  <span className="ml-1">{cat.icon}</span>
                  {cat.label} ({count})
                </button>
              );
            })}
          </div>

          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 بحث سريع في الخدمات…"
            className="w-full sm:w-60 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-navy-800"
          />
        </div>
      </div>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          جارٍ التحميل…
        </p>
      ) : services.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          لا خدمات مسجلة بعد.
        </p>
      ) : filteredServices.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          لا توجد خدمات مطابقة لبحثك.
        </p>
      ) : (
        grouped.map(([groupName, list]) => (
          <section key={groupName} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-extrabold text-navy-900">{categoryDisplayName(groupName)}</h2>
              {(CHART_CATEGORIES as readonly string[]).includes(groupName) ? (
                <span className="text-[10px] font-semibold text-emerald-600">✔ يُحدّث المخطط السني</span>
              ) : null}
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                {list.length}
              </span>
            </div>
            <ul className="space-y-2">
              {list.map((service) => (
                <li
                  key={service.id}
                  className={`rounded-2xl border p-3 transition-all ${
                    service.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-60"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-[10rem] flex-1 truncate">
                      <span className="text-sm font-extrabold text-navy-900">{service.name}</span>
                      <span className="mr-2 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        {categoryDisplayName(normalizeCategory(service.category))}
                      </span>
                    </div>

                    {editingId === service.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value)}
                          inputMode="decimal"
                          dir="ltr"
                          autoFocus
                          className="w-28 rounded-xl border border-navy-800 px-3 py-1.5 text-sm font-bold"
                        />
                        <button
                          onClick={async () => {
                            const ok = await send(() =>
                              fetch(`/api/services/${service.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ price: editPrice }),
                              }),
                            );
                            if (ok) setEditingId(null);
                          }}
                          disabled={busy}
                          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
                        >
                          حفظ
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600"
                        >
                          إلغاء
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-extrabold text-navy-900">
                          {formatMoney(service.priceMinor, base)}
                        </span>
                        <button
                          onClick={() => {
                            setEditingId(service.id);
                            setEditPrice(formatAmount(service.priceMinor, base).replace(/,/g, ""));
                          }}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50"
                        >
                          تعديل السعر
                        </button>
                        <button
                          onClick={() =>
                            send(() =>
                              fetch(`/api/services/${service.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ isActive: !service.isActive }),
                              }),
                            )
                          }
                          disabled={busy}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                        >
                          {service.isActive ? "إيقاف" : "تفعيل"}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <p className="mt-4 text-center text-[11px] text-slate-400">
        الخدمة تُوقَف ولا تُحذف حفاظًا على تكامل الفواتير السابقة وسجلات المرضى.
      </p>
    </main>
  );
}
