"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  EXPIRY_SOON_DAYS,
  MOVEMENT_LABEL,
  STOCK_STATUS_LABEL,
  expiryState,
  itemCategoryLabel,
  stockStatus,
  type BatchRemaining,
  type MovementKind,
  type StockStatus,
} from "@/lib/inventory";
import { friendlyDateLong } from "@/lib/reminders";

interface InventoryItemView {
  id: number;
  name: string;
  category: string;
  unit: string;
  minLevel: number;
  note: string | null;
  isActive: boolean;
  balance: number;
  status: StockStatus;
}

interface Alerts {
  lowItems: { id: number; name: string; balance: number; minLevel: number; status: StockStatus }[];
  expired: { itemId: number; itemName: string; batchId: number; expiryDate: string; remaining: number }[];
  soon: { itemId: number; itemName: string; batchId: number; expiryDate: string; remaining: number }[];
}

interface MovementView {
  id: number;
  kind: MovementKind;
  qty: number;
  expiryDate: string | null;
  reason: string | null;
  visitId: number | null;
  patientId: number | null;
  createdBy: string;
  createdAt: string;
}

interface Detail {
  item: InventoryItemView;
  movements: MovementView[];
  batches: { batches: BatchRemaining[]; adjustTotal: number };
}

const CATEGORIES = [
  { key: "all", label: "الكل", icon: "📦" },
  { key: "anesthesia", label: "تخدير وبنج", icon: "💉" },
  { key: "filling", label: "حشوات وجذور", icon: "🦷" },
  { key: "impression", label: "طبعات ومقاسات", icon: "📐" },
  { key: "ortho", label: "مستلزمات تقويم", icon: "🧲" },
  { key: "surgical", label: "جراحة وزراعة", icon: "🔪" },
  { key: "hygiene", label: "تعقيم ووقاية", icon: "🧤" },
  { key: "lab_supply", label: "مستلزمات معمل", icon: "🧪" },
  { key: "office", label: "قرطاسية وإدارة", icon: "📁" },
  { key: "other", label: "أخرى", icon: "✨" },
];

const STATUS_CLASS: Record<StockStatus, string> = {
  out: "bg-red-50 text-red-700 border-red-200",
  low: "bg-amber-50 text-amber-700 border-amber-200",
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItemView[]>([]);
  const [alerts, setAlerts] = useState<Alerts>({ lowItems: [], expired: [], soon: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Filters
  const [activeCategory, setActiveCategory] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | StockStatus>("all");
  const [search, setSearch] = useState("");

  // نموذج بند جديد
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("filling");
  const [unit, setUnit] = useState("علبة");
  const [minLevel, setMinLevel] = useState("3");
  const [initialQty, setInitialQty] = useState("");
  const [initialExpiry, setInitialExpiry] = useState("");

  // لوحة البند المفتوح
  const [detail, setDetail] = useState<Detail | null>(null);
  const [kind, setKind] = useState<MovementKind>("out");
  const [qty, setQty] = useState("");
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");

  const today = useMemo(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setItems((payload as { items: InventoryItemView[] }).items ?? []);
      setAlerts((payload as { alerts: Alerts }).alerts ?? { lowItems: [], expired: [], soon: [] });
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

  const openDetail = useCallback(async (id: number) => {
    setDetail(null);
    setKind("out");
    setQty("");
    setExpiry("");
    setReason("");
    try {
      const response = await fetch(`/api/inventory/${id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر فتح البند.");
      setDetail(payload as Detail);
    } catch (detailError) {
      setMessage(detailError instanceof Error ? detailError.message : "تعذّر فتح البند.");
    }
  }, []);

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category,
          unit: unit.trim() || "وحدة",
          minLevel: Number(minLevel) || 0,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإنشاء.");

      // إضافة حركة افتتاحية إذا تم تحديد كمية أولية
      if (initialQty && Number(initialQty) > 0 && payload?.id) {
        await fetch(`/api/inventory/${payload.id}/movements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "in",
            qty: Number(initialQty),
            expiryDate: initialExpiry || null,
            reason: "رصيد افتتاحي عند الإنشاء",
          }),
        });
      }

      setShowAdd(false);
      setName("");
      setMinLevel("3");
      setInitialQty("");
      setInitialExpiry("");
      setMessage("تم إنشاء البند بنجاح.");
      await load();
    } catch (addError) {
      setMessage(addError instanceof Error ? addError.message : "تعذّر الإنشاء.");
    } finally {
      setBusy(false);
    }
  };

  const addMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !detail || !qty) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/inventory/${detail.item.id}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          qty: Number(qty),
          expiryDate: kind === "in" && expiry ? expiry : null,
          reason: reason.trim() || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تسجيل الحركة.");
      setQty("");
      setExpiry("");
      setReason("");
      setMessage("تم تسجيل حركة المخزون بنجاح.");
      await Promise.all([load(), openDetail(detail.item.id)]);
    } catch (moveError) {
      setMessage(moveError instanceof Error ? moveError.message : "تعذّر تسجيل الحركة.");
    } finally {
      setBusy(false);
    }
  };

  const nearestExpiry = (id: number): string | null => {
    const expiries = alerts.expired
      .filter((a) => a.itemId === id)
      .map((a) => a.expiryDate)
      .concat(alerts.soon.filter((a) => a.itemId === id).map((a) => a.expiryDate));
    return expiries.length ? expiries.sort()[0] : null;
  };

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchCat = activeCategory === "all" || item.category === activeCategory;
      const status = stockStatus(item.balance, item.minLevel);
      const matchStatus = statusFilter === "all" || status === statusFilter;
      const matchSearch =
        !search.trim() ||
        item.name.toLowerCase().includes(search.toLowerCase().trim()) ||
        itemCategoryLabel(item.category).toLowerCase().includes(search.toLowerCase().trim());
      return matchCat && matchStatus && matchSearch;
    });
  }, [items, activeCategory, statusFilter, search]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 pb-24">
      <PageHeader
        title="إدارة المخزون والمستهلكات السنية"
        subtitle="تتبع دقيق للمواد، حركة الوارد والصرف، وتنبيهات الصلاحية وحد الطلب التلقائية"
      >
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white shadow-xs transition-opacity hover:opacity-90"
        >
          {showAdd ? "✕ إغلاق النموذج" : "+ إضافة مادة جديدة للمخزن"}
        </button>
      </PageHeader>

      {message ? (
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs font-bold text-sky-800">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-bold text-red-700">
          {error}
        </div>
      ) : null}

      {/* نموذج إضافة بند جديد */}
      {showAdd ? (
        <form onSubmit={addItem} className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <h3 className="mb-3 text-sm font-extrabold text-navy-900">+ إضافة مادة / مستهلك جديد للمخزن</h3>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">اسم المادة أو البند *</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                placeholder="مثال: حشوة كمبوزيت A2"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">التصنيف *</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                {CATEGORIES.filter((c) => c.key !== "all").map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.icon} {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">وحدة القياس</span>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                placeholder="علبة / سرنجة / كيس / طقم"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">حد الطلب (تنبيه عند الوصول له)</span>
              <input
                value={minLevel}
                onChange={(e) => setMinLevel(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                placeholder="3"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">الكمية الافتتاحية الحالية</span>
              <input
                value={initialQty}
                onChange={(e) => setInitialQty(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                placeholder="0"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-700">تاريخ الصلاحية الافتتاحي</span>
              <input
                type="date"
                value={initialExpiry}
                onChange={(e) => setInitialExpiry(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              حفظ البند في المخزن
            </button>
          </div>
        </form>
      ) : null}

      {/* التنبيهات الذكية */}
      {alerts.expired.length > 0 || alerts.soon.length > 0 || alerts.lowItems.length > 0 ? (
        <section className="mb-5 grid gap-3 md:grid-cols-3">
          {alerts.expired.length > 0 ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5 text-xs">
              <p className="font-extrabold text-red-700">🚨 دفعات منتهية الصلاحية: {alerts.expired.length}</p>
              <ul className="mt-1.5 space-y-1 text-red-700">
                {alerts.expired.slice(0, 3).map((a) => (
                  <li key={a.batchId}>
                    • <span className="font-bold">{a.itemName}</span> — انتهت {a.expiryDate} (متبقي {fmt(a.remaining)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {alerts.soon.length > 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs">
              <p className="font-extrabold text-amber-700">
                ⚠️ تقارب الانتهاء (خلال {EXPIRY_SOON_DAYS} يوم): {alerts.soon.length}
              </p>
              <ul className="mt-1.5 space-y-1 text-amber-800">
                {alerts.soon.slice(0, 3).map((a) => (
                  <li key={a.batchId}>
                    • <span className="font-bold">{a.itemName}</span> — {a.expiryDate} (متبقي {fmt(a.remaining)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {alerts.lowItems.length > 0 ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-3.5 text-xs">
              <p className="font-extrabold text-sky-800">📉 تحت حد الطلب: {alerts.lowItems.length}</p>
              <ul className="mt-1.5 space-y-1 text-sky-800">
                {alerts.lowItems.slice(0, 3).map((i) => (
                  <li key={i.id}>
                    • <span className="font-bold">{i.name}</span> — المتبقي {fmt(i.balance)} (الحد {fmt(i.minLevel)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* شريط الفلترة والبحث والتصنيفات */}
      <div className="mb-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* تبويبات الأقسام */}
          <div className="flex flex-wrap items-center gap-1">
            {CATEGORIES.map((cat) => {
              const count =
                cat.key === "all"
                  ? items.length
                  : items.filter((i) => i.category === cat.key).length;
              const isSelected = activeCategory === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveCategory(cat.key)}
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

          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | StockStatus)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 outline-none"
            >
              <option value="all">كل الحالات ({items.length})</option>
              <option value="ok">متوفر</option>
              <option value="low">تحت حد الطلب</option>
              <option value="out">منتهي (نفد)</option>
            </select>

            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 بحث في المواد والمستهلكات…"
              className="w-full sm:w-60 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-navy-800"
            />
          </div>
        </div>
      </div>

      {/* جدول بنود المخزون */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        {loading ? (
          <p className="p-8 text-center text-xs text-slate-400">جارٍ التحميل…</p>
        ) : items.length === 0 ? (
          <p className="p-8 text-center text-xs text-slate-400">
            لا توجد مواد مسجلة بالمخزن بعد.
          </p>
        ) : filteredItems.length === 0 ? (
          <p className="p-8 text-center text-xs text-slate-400">
            لا توجد نتائج مطابقة للبحث أو التصنيف المحدد.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 font-bold text-slate-500">
                  <th className="px-4 py-3">المادة / البند</th>
                  <th className="px-4 py-3">التصنيف</th>
                  <th className="px-4 py-3">الرصيد الفعلي</th>
                  <th className="px-4 py-3">حد الطلب</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">أقرب صلاحية</th>
                  <th className="px-4 py-3 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.map((item) => {
                  const expiry = nearestExpiry(item.id);
                  const expiryClass = expiry ? expiryState(expiry, today) : null;
                  const currentStatus = stockStatus(item.balance, item.minLevel);
                  const isSelected = detail?.item.id === item.id;

                  return (
                    <tr
                      key={item.id}
                      onClick={() => void openDetail(item.id)}
                      className={`cursor-pointer transition-colors hover:bg-slate-50/80 ${
                        isSelected ? "bg-navy-50/60" : item.isActive ? "" : "opacity-50"
                      }`}
                    >
                      <td className="px-4 py-3 font-extrabold text-navy-900">{item.name}</td>
                      <td className="px-4 py-3 text-slate-600">{itemCategoryLabel(item.category)}</td>
                      <td className="px-4 py-3 font-black text-navy-900">
                        {fmt(item.balance)} <span className="text-[11px] font-normal text-slate-500">{item.unit}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-500">{fmt(item.minLevel)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${
                            STATUS_CLASS[currentStatus]
                          }`}
                        >
                          {STOCK_STATUS_LABEL[currentStatus]}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-3 ${
                          expiryClass === "expired"
                            ? "font-extrabold text-red-600"
                            : expiryClass === "soon"
                            ? "font-bold text-amber-600"
                            : "text-slate-600"
                        }`}
                      >
                        {expiry ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-navy-800 hover:bg-white shadow-2xs"
                        >
                          سجل الحركات
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* لوحة تفاصيل البند المفتوح وتسجيل الحركات */}
      {detail ? (
        <section className="mt-5 rounded-2xl border border-navy-800 bg-white p-5 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-extrabold text-navy-900">{detail.item.name}</h3>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
                  {itemCategoryLabel(detail.item.category)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                الرصيد الفعلي الحالي: <span className="font-extrabold text-navy-900">{fmt(detail.item.balance)} {detail.item.unit}</span>
                {detail.item.minLevel > 0 ? ` · حد الطلب: ${fmt(detail.item.minLevel)}` : ""}
              </p>
            </div>
            <button
              onClick={() => setDetail(null)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
            >
              ✕ إغلاق
            </button>
          </div>

          <div className="mt-4 grid gap-6 md:grid-cols-2">
            {/* نموذج تسجيل حركة جديدة */}
            <form onSubmit={addMovement} className="space-y-3 rounded-xl bg-slate-50 p-4 border border-slate-200">
              <h4 className="text-xs font-extrabold text-navy-900">تسجيل حركة جديدة على البند</h4>
              <div className="grid grid-cols-3 gap-1">
                {(["out", "in", "adjust"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`rounded-xl py-1.5 text-xs font-bold transition-all ${
                      kind === k
                        ? "bg-navy-800 text-white shadow-xs"
                        : "bg-white text-slate-600 border border-slate-200"
                    }`}
                  >
                    {MOVEMENT_LABEL[k]}
                  </button>
                ))}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">
                  <span className="mb-1 block font-bold text-slate-700">
                    الكمية ({detail.item.unit}) *
                  </span>
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    required
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                  />
                </label>

                {kind === "in" ? (
                  <label className="text-xs">
                    <span className="mb-1 block font-bold text-slate-700">تاريخ الصلاحية</span>
                    <input
                      type="date"
                      value={expiry}
                      onChange={(e) => setExpiry(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                    />
                  </label>
                ) : null}

                <label className="text-xs sm:col-span-2">
                  <span className="mb-1 block font-bold text-slate-700">
                    {kind === "adjust" ? "سبب التسوية (إلزامي) *" : "السبب أو الملاحظة"}
                  </span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required={kind === "adjust"}
                    placeholder={
                      kind === "out"
                        ? "مثال: استهلاك عيادة أو علاج مريض"
                        : kind === "in"
                        ? "مثال: فاتورة شراء رقم #123"
                        : "مثال: نقص بعد الجرد الدوري"
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={busy || !qty || (kind === "adjust" && !reason.trim())}
                className="w-full rounded-xl bg-navy-800 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                تأكيد وقيد الحركة
              </button>
            </form>

            {/* سجل الحركات والدفعات */}
            <div className="space-y-3">
              <h4 className="text-xs font-extrabold text-navy-900">
                سجل الحركات السابقة ({detail.movements.length})
              </h4>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {detail.movements.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-4">لا توجد حركات مسجلة بعد</p>
                ) : (
                  detail.movements.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-white p-2.5 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                              m.kind === "in"
                                ? "bg-emerald-50 text-emerald-700"
                                : m.kind === "out"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {MOVEMENT_LABEL[m.kind]}
                          </span>
                          <span className="font-extrabold text-navy-900">
                            {m.kind === "out" ? "-" : "+"}
                            {fmt(m.qty)} {detail.item.unit}
                          </span>
                        </div>
                        {m.reason ? <p className="mt-0.5 text-[11px] text-slate-500">{m.reason}</p> : null}
                      </div>
                      <div className="text-left text-[11px] text-slate-400">
                        <p>{friendlyDateLong(m.createdAt.slice(0, 10))}</p>
                        <p>{m.createdBy}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
