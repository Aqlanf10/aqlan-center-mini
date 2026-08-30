"use client";

import { useCallback, useEffect, useState } from "react";
import { friendlyDateLong } from "@/lib/reminders";
import { itemCategoryLabel } from "@/lib/inventory";

interface InventoryItem {
  id: number;
  name: string;
  category: string;
  unit: string;
  balance: number;
  isActive: boolean;
}

interface MaterialMovement {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  kind: "in" | "out" | "adjust";
  qty: number;
  reason: string | null;
  visitId: number | null;
  createdBy: string;
  createdAt: string;
}

export function PatientMaterials({
  patientId,
  visits = [],
}: {
  patientId: number;
  visits?: { id: number; arrivedAt: string }[];
}) {
  const [consumptions, setConsumptions] = useState<MaterialMovement[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [qty, setQty] = useState("1");
  const [selectedVisitId, setSelectedVisitId] = useState<number | "">("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [matRes, invRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/materials`, { cache: "no-store" }),
        fetch("/api/inventory", { cache: "no-store" }),
      ]);

      if (matRes.ok) {
        const data = await matRes.json();
        setConsumptions(Array.isArray(data) ? data : data.movements ?? []);
      }

      if (invRes.ok) {
        const invData = await invRes.json();
        const rawItems = (invData.items ?? invData) as InventoryItem[];
        setItems(rawItems.filter((i) => i.isActive !== false));
      }
      setError(null);
    } catch {
      setError("تعذّر تحميل سجل المستهلكات.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedItem = items.find((i) => i.id === selectedItemId);

  const submitConsumption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedItemId || !qty || busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/inventory/${selectedItemId}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "out",
          qty: Number(qty),
          reason: reason.trim() || `صرف علاجي للمريض #${patientId}`,
          visitId: selectedVisitId || null,
          patientId,
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.message ?? "تعذّر تسجيل صرف المادة.");
        return;
      }

      setShowAdd(false);
      setSelectedItemId("");
      setQty("1");
      setReason("");
      setSelectedVisitId("");
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-navy-900">المستهلكات والمواد الطبية المصروفة للمريض</h3>
          <p className="text-xs text-slate-500">تتبع المواد المستخدمة في جلسات العلاج وربطها بالمخزن المباشر</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          className="rounded-xl bg-navy-800 px-3.5 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
        >
          {showAdd ? "إلغاء" : "+ صرف مادة من المخزن"}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
      ) : null}

      {showAdd ? (
        <form onSubmit={submitConsumption} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <h4 className="text-xs font-bold text-navy-900">تسجيل صرف مادة سنية لعلاج المريض</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">اختر المادة / المستهلك *</span>
              <select
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value ? Number(e.target.value) : "")}
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                <option value="">— اختر المادة من المخزن —</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.balance <= 0}>
                    {item.name} ({itemCategoryLabel(item.category)}) — الرصيد المتوفر: {item.balance} {item.unit}
                    {item.balance <= 0 ? " [منتهي]" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">
                الكمية المصروفة {selectedItem ? `(${selectedItem.unit})` : ""} *
              </span>
              <input
                type="number"
                min="0.1"
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">ربط بزيارة علاجية (اختياري)</span>
              <select
                value={selectedVisitId}
                onChange={(e) => setSelectedVisitId(e.target.value ? Number(e.target.value) : "")}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              >
                <option value="">— بدون ربط بزيارة محددة —</option>
                {visits.map((v) => (
                  <option key={v.id} value={v.id}>
                    زيارة {v.arrivedAt ? v.arrivedAt.slice(0, 10) : `#${v.id}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">بيان الاستخدام / الإجراء السريري</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: حشوة كمبوزيت سن 16، أو تخدير موضعي لجراحة"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-1.5 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !selectedItemId || !qty}
              className="rounded-xl bg-brand-orange px-5 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            >
              خصم وصرف من المخزن
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
          جارٍ التحميل…
        </p>
      ) : consumptions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-bold text-slate-600">لا توجد مواد مسجلة مصروفة لهذا المريض بعد</p>
          <p className="mt-1 text-xs text-slate-400">
            يمكنك تسجيل استهلاك المواد (البنج، الحشوات، الغرسات، مستلزمات التقويم) لحفظ سجل دقيق لتكلفة علاج المريض
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {consumptions.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 text-xs"
            >
              <div className="min-w-[12rem] flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-navy-900">{c.itemName}</span>
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 font-bold text-slate-700">
                    {c.qty} {c.unit}
                  </span>
                </div>
                {c.reason ? <p className="mt-0.5 text-slate-500">{c.reason}</p> : null}
              </div>

              <div className="text-left text-slate-400">
                <p className="font-medium">{friendlyDateLong(c.createdAt ? c.createdAt.slice(0, 10) : "")}</p>
                <p className="text-[11px]">بواسطة: {c.createdBy}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
