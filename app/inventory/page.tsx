"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  EXPIRY_SOON_DAYS, MOVEMENT_LABEL, STOCK_STATUS_LABEL,
  expiryState, itemCategoryLabel, stockStatus,
  type BatchRemaining, type MovementKind, type StockStatus,
} from "@/lib/inventory";

/**
 * المخزون والمستهلكات السنية — المرحلة 9.
 *
 * الشاشة تفتح على ما يستحق انتباهًا لا على «الكل»: بندٌ منتهٍ أو قارب الانتهاء
 * يُكتشف يوم الحاجة إليه متأخرًا أصلًا، وبندٌ تحت حد الطلب يُطلب اليوم وإلا
 * توقف عمل غدًا. والرصيد المعروض هنا ليس رقمًا محفوظًا — هو حصيلة الحركات
 * المشتقة، وأي «تصحيح» له يمرّ حتمًا بحركة تسوية بسببها المكتوب.
 */

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
  createdBy: string;
  createdAt: string;
}

interface Detail {
  item: InventoryItemView;
  movements: MovementView[];
  batches: { batches: BatchRemaining[]; adjustTotal: number };
}

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

  // نموذج بند جديد
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [unit, setUnit] = useState("وحدة");
  const [minLevel, setMinLevel] = useState("");

  // لوحة البند المفتوح
  const [detail, setDetail] = useState<Detail | null>(null);
  const [kind, setKind] = useState<MovementKind>("out");
  const [qty, setQty] = useState("");
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");

  const today = useMemo(() => {
    // تاريخ العيادة لا UTC: بعد منتصف الليل بغرينتش يبقى اليوم أمسٍ في تعز.
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setItems((payload as { items: InventoryItemView[] }).items);
      setAlerts((payload as { alerts: Alerts }).alerts);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: number) => {
    setDetail(null);
    setKind("out"); setQty(""); setExpiry(""); setReason("");
    try {
      const response = await fetch(`/api/inventory/${id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setDetail(payload as Detail);
    } catch (detailError) {
      setMessage(detailError instanceof Error ? detailError.message : "تعذّر فتح البند.");
    }
  }, []);

  const addItem = async () => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, category, unit, minLevel: Number(minLevel) || 0 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإنشاء.");
      setShowAdd(false); setName(""); setMinLevel("");
      setMessage("أُنشئ البند — أضف أول حركة إدخال عليه.");
      await load();
    } catch (addError) {
      setMessage(addError instanceof Error ? addError.message : "تعذّر الإنشاء.");
    } finally {
      setBusy(false);
    }
  };

  const addMovement = async () => {
    if (busy || !detail) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/inventory/${detail.item.id}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          qty: Number(qty),
          expiryDate: kind === "in" && expiry ? expiry : null,
          reason: reason || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تسجيل الحركة.");
      setQty(""); setExpiry(""); setReason("");
      setMessage("سُجّلت الحركة.");
      await Promise.all([load(), openDetail(detail.item.id)]);
    } catch (moveError) {
      setMessage(moveError instanceof Error ? moveError.message : "تعذّر تسجيل الحركة.");
    } finally {
      setBusy(false);
    }
  };

  const nearestExpiry = (id: number): string | null => {
    const expiries = alerts.expired.filter((a) => a.itemId === id).map((a) => a.expiryDate)
      .concat(alerts.soon.filter((a) => a.itemId === id).map((a) => a.expiryDate));
    return expiries.length ? expiries.sort()[0] : null;
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        title="المخزون"
        subtitle="المستهلكات السنية — الرصيد اشتقاقٌ من الحركات، ولا تسوية بلا سبب موثَّق."
      >
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700"
        >
          {showAdd ? "إغلاق النموذج" : "بند جديد"}
        </button>
      </PageHeader>

      {message ? (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">{message}</div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      {showAdd ? (
        <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">اسم البند</span>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="مثال: مادة لحمية" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">التصنيف</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2">
                {["anesthesia", "filling", "impression", "ortho", "surgical", "hygiene", "lab_supply", "office", "other"].map((c) => (
                  <option key={c} value={c}>{itemCategoryLabel(c)}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">الوحدة</span>
              <input value={unit} onChange={(e) => setUnit(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="علبة / سمّالة / مم" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">حد الطلب (ينبّه دونها)</span>
              <input value={minLevel} onChange={(e) => setMinLevel(e.target.value)} inputMode="decimal"
                className="w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="0" />
            </label>
          </div>
          <button onClick={addItem} disabled={busy || !name.trim()}
            className="mt-3 rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            إنشاء البند
          </button>
        </section>
      ) : null}

      {/* التنبيهات أولًا — الشاشة تفتح على ما يستحق الانتباه */}
      {alerts.expired.length > 0 || alerts.soon.length > 0 || alerts.lowItems.length > 0 ? (
        <section className="mb-5 grid gap-3 md:grid-cols-3">
          {alerts.expired.length > 0 ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
              <p className="font-bold text-red-700">دفعات منتهية: {alerts.expired.length}</p>
              <ul className="mt-1 space-y-0.5 text-red-700">
                {alerts.expired.slice(0, 4).map((a) => (
                  <li key={a.batchId}>{a.itemName} — انتهت {a.expiryDate} (بقي {fmt(a.remaining)})</li>
                ))}
              </ul>
            </div>
          ) : null}
          {alerts.soon.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="font-bold text-amber-700">تقارب الانتهاء (خلال {EXPIRY_SOON_DAYS} يومًا): {alerts.soon.length}</p>
              <ul className="mt-1 space-y-0.5 text-amber-800">
                {alerts.soon.slice(0, 4).map((a) => (
                  <li key={a.batchId}>{a.itemName} — {a.expiryDate} (بقي {fmt(a.remaining)})</li>
                ))}
              </ul>
            </div>
          ) : null}
          {alerts.lowItems.length > 0 ? (
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm">
              <p className="font-bold text-sky-800">تحت حد الطلب: {alerts.lowItems.length}</p>
              <ul className="mt-1 space-y-0.5 text-sky-800">
                {alerts.lowItems.slice(0, 4).map((i) => (
                  <li key={i.id}>{i.name} — المتبقي {fmt(i.balance)} من حد {fmt(i.minLevel)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <p className="p-6 text-center text-sm text-slate-500">جارٍ التحميل…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            لا بنود بعد — أضف أول بند ثم سجّل عليه حركة إدخال بشرائه.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-right text-xs text-slate-500">
                <th className="px-3 py-2">البند</th>
                <th className="px-3 py-2">التصنيف</th>
                <th className="px-3 py-2">الرصيد</th>
                <th className="px-3 py-2">حد الطلب</th>
                <th className="px-3 py-2">الحالة</th>
                <th className="px-3 py-2">أقرب صلاحية</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const expiry = nearestExpiry(item.id);
                const expiryClass = expiry ? expiryState(expiry, today) : null;
                return (
                  <tr key={item.id}
                    onClick={() => void openDetail(item.id)}
                    className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${item.isActive ? "" : "opacity-50"}`}>
                    <td className="px-3 py-2 font-semibold text-navy-900">{item.name}</td>
                    <td className="px-3 py-2 text-slate-600">{itemCategoryLabel(item.category)}</td>
                    <td className="px-3 py-2 font-bold">{fmt(item.balance)} <span className="text-xs font-normal text-slate-500">{item.unit}</span></td>
                    <td className="px-3 py-2 text-slate-600">{fmt(item.minLevel)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[stockStatus(item.balance, item.minLevel)]}`}>
                        {STOCK_STATUS_LABEL[stockStatus(item.balance, item.minLevel)]}
                      </span>
                    </td>
                    <td className={`px-3 py-2 ${expiryClass === "expired" ? "font-bold text-red-700" : expiryClass === "soon" ? "text-amber-700" : "text-slate-600"}`}>
                      {expiry ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {detail ? (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-navy-900">
              {detail.item.name}
              <span className="mr-2 text-sm font-normal text-slate-500">
                الرصيد {fmt(detail.item.balance)} {detail.item.unit}
              </span>
            </h2>
            <button onClick={() => setDetail(null)} className="text-sm text-slate-500 hover:text-navy-800">إغلاق</button>
          </div>

          {/* تسجيل حركة — سبب التسوية حقلٌ مستقل تحته لأنه إلزامي لا اختياري */}
          <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-4">
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">نوع الحركة</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as MovementKind)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5">
                {(Object.keys(MOVEMENT_LABEL) as MovementKind[]).map((k) => (
                  <option key={k} value={k}>{MOVEMENT_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-slate-700">
                {kind === "adjust" ? "الفرق (موجب/سالب)" : "الكمية"}
              </span>
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal"
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5" />
            </label>
            {kind === "in" ? (
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-slate-700">تاريخ الصلاحية (دفعة)</span>
                <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5" />
              </label>
            ) : (
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-slate-700">
                  {kind === "adjust" ? "سبب التسوية (إلزامي)" : "ملاحظة (اختياري)"}
                </span>
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5"
                  placeholder={kind === "adjust" ? "نقص، تلف، تصحيح إحصاء…" : ""} />
              </label>
            )}
            <div className="flex items-end">
              <button onClick={addMovement} disabled={busy || !qty}
                className="w-full rounded-lg bg-navy-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                تسجيل الحركة
              </button>
            </div>
          </div>

          {/* الدفعات بما بقي فيها */}
          {detail.batches.batches.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-bold text-slate-700">دفعات الصلاحية (الصرف يستهلك الأقرب انتهاءً)</h3>
              <ul className="text-xs text-slate-600">
                {detail.batches.batches.map((b) => {
                  const state = b.expiryDate ? expiryState(b.expiryDate, today) : "ok";
                  return (
                    <li key={b.id} className="flex justify-between border-b border-slate-100 py-1">
                      <span>دفعة #{b.id} — {b.expiryDate ?? "بلا صلاحية"}</span>
                      <span className={state === "expired" && b.remaining > 0 ? "font-bold text-red-700" : ""}>
                        دخل {fmt(b.inQty)} · بقي {fmt(b.remaining)}
                      </span>
                    </li>
                  );
                })}
                {detail.batches.adjustTotal !== 0 ? (
                  <li className="flex justify-between py-1 font-semibold">
                    <span>أثر التسويات</span><span>{fmt(detail.batches.adjustTotal)}</span>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {/* سجل الحركات */}
          <div className="mt-4">
            <h3 className="mb-1 text-sm font-bold text-slate-700">سجل الحركات</h3>
            <ul className="text-xs text-slate-600">
              {detail.movements.map((m) => (
                <li key={m.id} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 py-1">
                  <span>
                    <span className={`font-bold ${m.kind === "in" ? "text-emerald-700" : m.kind === "out" ? "text-red-700" : "text-amber-700"}`}>
                      {MOVEMENT_LABEL[m.kind]}
                    </span>
                    {" "}{fmt(m.qty)} {detail.item.unit}
                    {m.expiryDate ? ` — صلاحية ${m.expiryDate}` : ""}
                  </span>
                  <span className="text-slate-400">
                    {m.createdBy} · {new Date(m.createdAt).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })}
                    {m.reason ? ` — ${m.reason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}
