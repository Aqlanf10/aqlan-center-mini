"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CLINIC_BASE_CURRENCY, formatAmount, formatMoney, type Currency } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { useSession } from "@/components/SessionProvider";
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
  priceConfigured: boolean;
  priceProvisional: boolean;
  /** (DAY1) سعرها الخاص بالسعودي والدولار — null: يُحوَّل من اليمني بسعر الصرف. */
  priceSarMinor?: number | null;
  priceUsdMinor?: number | null;
  /** السعر الذي ستُسعَّر به في زيارةٍ بكل عملة (الخاص أو المحوَّل). */
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}

/* أسعار الدفعة: تُكتب هنا وتُرسل كلُّها مرةً واحدة — من مستودع الوكيل الآخر. */
interface BatchPrice {
  id: number;
  name: string;
  priceMinor: number;
  priceConfigured: boolean;
  priceProvisional: boolean;
  draft: string;
}

export default function ServicesPage() {
  const readOnly = useSession()?.role === "accountant";
  // (TD-05) الأساس دستوري من الكود.
  const base: Currency = CLINIC_BASE_CURRENCY;

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
  const [editSar, setEditSar] = useState("");
  const [editUsd, setEditUsd] = useState("");
  /* تسعير الدفعة (من مستودع الوكيل الآخر): كل الدليل في نمطٍ واحد — الإدخال
     يبدأ من الأسعار القائمة، وواحدٌ خاطئ يردّ الدفعة كلَّها باسم صاحبه. */
  const [batchMode, setBatchMode] = useState(false);
  const [batch, setBatch] = useState<BatchPrice[]>([]);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

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

  /* دخول نمط الدفعة: تُبنى المسوّدة من الأسعار القائمة حتى يُعدّل لا من فراغ. */
  const enterBatchMode = () => {
    setBatch(services.filter((service) => service.isActive).map((service) => ({
      id: service.id,
      name: service.name,
      priceMinor: service.priceMinor,
      priceConfigured: service.priceConfigured,
      priceProvisional: service.priceProvisional,
      draft: formatAmount(service.priceMinor, base).replace(/,/g, ""),
    })));
    setBatchMessage(null);
    setBatchMode(true);
  };

  /* والدفعة كلُّها أو لا شيء: وواحدٌ فارغٌ أو صفر يردّها كلَّها قبل أن تلمس القاعدة. */
  const saveBatch = async () => {
    if (busy) return;
    setBusy(true);
    setBatchMessage(null);
    try {
      const entries = batch.map((row) => ({ id: row.id, price: row.draft }));
      const response = await fetch("/api/services/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setBatchMessage(payload?.message ?? "تعذّر حفظ الدفعة.");
        return;
      }
      setBatchMessage(`حُفظت ${payload?.updated ?? entries.length} سعرًا دفعةً واحدة.`);
      setBatchMode(false);
      await load();
    } catch {
      setBatchMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  /* ملء تخميني موسوم: للتجربة قبل أن يقرّ المالك قائمته — ولا يمسّ مسعّرًا. */
  const fillProvisional = async () => {
    if (busy) return;
    setBusy(true);
    setBatchMessage(null);
    try {
      const response = await fetch("/api/services/provisional", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setBatchMessage(payload?.message ?? "تعذّر الملء التخميني.");
        return;
      }
      setBatchMessage(`مُلئت ${payload?.filled ?? 0} خدمة بأسعار تخمينية موسومة — والجاهزية تنبّه عليها حتى تستبدلها.`);
      await load();
    } catch {
      setBatchMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

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
      {!readOnly ? <form onSubmit={add} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
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
      </form> : null}

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

      {/*
        * بوابة التسعير (من مستودع الوكيل الآخر): الدفعة كلُّها أو لا شيء،
        * والتخميني الموسوم للتجربة قبل قرار المالك — والوسم يُمسح بيده.
        */}
      {batchMessage ? (
        <p className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-900">
          {batchMessage}
        </p>
      ) : null}
      {!readOnly ? <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex-1 text-[11px] font-bold text-slate-500">
          {batchMode
            ? "كلُّ الأسعار في نمطٍ واحد: اكتب ثم احفظ الدفعة — واحدٌ خاطئ يردّها كلَّها قبل أن تُحفظ."
            : "التسعير واحدًا واحدًا يقف في المنتصف فيبقى نصف الدليل بلا سعر — فالدليل يُسعَّر دفعةً واحدة."}
        </div>
        {batchMode ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void saveBatch()} disabled={busy}
              className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-extrabold text-white disabled:opacity-40">
              احفظ الدفعة كلها
            </button>
            <button type="button" onClick={() => setBatchMode(false)}
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
              خروج من نمط الدفعة
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={enterBatchMode}
              className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-extrabold text-white">
              📝 تسعير الدليل دفعة واحدة
            </button>
            <button type="button" onClick={() => void fillProvisional()} disabled={busy}
              title="أرقام تخمينية للتجربة، تُوسَم «تخميني» وتُنبّه عليها الجاهزية حتى يستبدلها المالك"
              className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 disabled:opacity-40">
              ⚡ ملء تخميني موسوم
            </button>
          </div>
        )}
      </div> : null}

      {!readOnly && batchMode ? (
        <section className="mb-6 rounded-2xl border-2 border-navy-800/30 bg-white p-4">
          <h2 className="mb-2 text-sm font-extrabold text-navy-900">تسعير الدفعة — {batch.length} خدمة نشطة</h2>
          <ul className="divide-y divide-slate-100">
            {batch.map((row, index) => (
              <li key={row.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-[10rem] flex-1 truncate">
                  <span className="text-xs font-bold text-slate-800">{row.name}</span>
                  {row.priceProvisional ? (
                    <span className="mr-1.5 rounded-md border border-amber-300 bg-amber-50 px-1.5 text-[10px] font-bold text-amber-700">تخميني</span>
                  ) : row.priceConfigured ? null : (
                    <span className="mr-1.5 rounded-md border border-rose-200 bg-rose-50 px-1.5 text-[10px] font-bold text-rose-600">بلا سعر</span>
                  )}
                </div>
                <input
                  value={row.draft}
                  onChange={(event) => setBatch((current) => {
                    const next = [...current];
                    next[index] = { ...row, draft: event.target.value };
                    return next;
                  })}
                  inputMode="decimal"
                  dir="ltr"
                  className="w-32 rounded-xl border border-slate-300 px-3 py-1.5 text-center text-sm font-bold tabular-nums"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                      {service.priceProvisional ? (
                        <span className="mr-1.5 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700" title="سعرٌ تخميني للتجربة — عدّله بيدك فيُصبح قرارك ويمسح الوسم">
                          تخميني
                        </span>
                      ) : service.priceConfigured ? null : (
                        <span className="mr-1.5 rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600" title="لم يُسعّرها أحد بعد">
                          بلا سعر
                        </span>
                      )}
                    </div>

                    {editingId === service.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-[10px] font-bold text-slate-500">
                          يمني
                          <input
                            value={editPrice}
                            onChange={(e) => setEditPrice(e.target.value)}
                            inputMode="decimal"
                            dir="ltr"
                            autoFocus
                            className="block w-28 rounded-xl border border-navy-800 px-3 py-1.5 text-sm font-bold"
                          />
                        </label>
                        <label className="text-[10px] font-bold text-slate-500">
                          سعودي
                          <input
                            value={editSar}
                            onChange={(e) => setEditSar(e.target.value)}
                            inputMode="decimal"
                            dir="ltr"
                            placeholder="تحويل تلقائي"
                            className="block w-28 rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-bold"
                          />
                        </label>
                        <label className="text-[10px] font-bold text-slate-500">
                          دولار
                          <input
                            value={editUsd}
                            onChange={(e) => setEditUsd(e.target.value)}
                            inputMode="decimal"
                            dir="ltr"
                            placeholder="تحويل تلقائي"
                            className="block w-28 rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-bold"
                          />
                        </label>
                        <button
                          onClick={async () => {
                            const ok = await send(() =>
                              fetch(`/api/services/${service.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                // الفارغ في السعودي/الدولار يعني: حوِّل من اليمني بسعر الصرف.
                                body: JSON.stringify({ price: editPrice, priceSar: editSar, priceUsd: editUsd }),
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
                        {(["SAR", "USD"] as const).map((currency) => {
                          const priced = service.priceIn?.[currency];
                          if (!priced || priced.minor === null) return null;
                          return (
                            <span key={currency} className="text-xs font-bold text-slate-600"
                              title={priced.source === "converted" ? "محوَّل من السعر اليمني بسعر الصرف — اكتب سعرًا خاصًّا لتثبيته" : "سعرٌ خاص قرّرته"}>
                              {formatMoney(priced.minor, currency)}
                              {priced.source === "converted" ? <span className="mr-0.5 text-[10px] font-semibold text-slate-400">(محوَّل)</span> : null}
                            </span>
                          );
                        })}
                        {!readOnly ? <button
                          onClick={() => {
                            setEditingId(service.id);
                            setEditPrice(formatAmount(service.priceMinor, base).replace(/,/g, ""));
                            setEditSar(service.priceSarMinor != null ? formatAmount(service.priceSarMinor, "SAR").replace(/,/g, "") : "");
                            setEditUsd(service.priceUsdMinor != null ? formatAmount(service.priceUsdMinor, "USD").replace(/,/g, "") : "");
                          }}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50"
                        >
                          تعديل السعر
                        </button> : null}
                        {!readOnly ? <button
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
                        </button> : null}
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
