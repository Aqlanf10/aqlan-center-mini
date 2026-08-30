"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong } from "@/lib/reminders";

interface LabOrder {
  id: number;
  patientId: number;
  patientName: string;
  patientNumber: string;
  labName: string;
  labPhone: string | null;
  workType: string;
  details: string | null;
  sentDate: string;
  dueDate: string;
  status: "sent" | "received" | "delivered";
  deliveredAt: string | null;
  note: string | null;
  costMinor: number | null;
  costCurrency: Currency | null;
  baseAmountMinor: number | null;
  createdAt: string;
}

const WORK_TYPES = [
  "تاج زيركون كامل (Full Zirconia)",
  "تاج إيماكس (E.max Crown)",
  "عدسة فينير (Veneer)",
  "تاج بورسلين ميتال (PFM)",
  "جسر زيركون (Zirconia Bridge)",
  "طقم أسنان كامل (Full Denture)",
  "طقم أسنان جزئي كاست (Cast Partial)",
  "حافظ مسافة (Space Maintainer)",
  "جهاز تقويم متحرك (Removable Appliance)",
  "واقي أسنان ليلي (Night Guard)",
  "تاج مؤقت (Temporary Crown)",
  "صب وتجهيز قالب دراسة (Study Model)",
  "أخرى (مخصص)",
];

const STATUS_MAP: Record<string, { label: string; bg: string; text: string }> = {
  sent: { label: "قيد العمل بالمختبر", bg: "bg-amber-50 border-amber-200", text: "text-amber-700" },
  received: { label: "مستلم بالعيادة", bg: "bg-blue-50 border-blue-200", text: "text-blue-700" },
  delivered: { label: "تم التسليم للمريض", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700" },
};

export function PatientLabOrders({
  patientId,
  patientName,
  base = "YER",
}: {
  patientId: number;
  patientName: string;
  base?: Currency;
}) {
  const [orders, setOrders] = useState<LabOrder[]>([]);
  const [labs, setLabs] = useState<{ labName: string; labPhone: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // حقول الإضافة
  const [labName, setLabName] = useState("");
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [customWork, setCustomWork] = useState("");
  const [details, setDetails] = useState("");
  const [sentDate, setSentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return d.toISOString().slice(0, 10);
  });
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lab?patientId=${patientId}`, { cache: "no-store" });
      if (!res.ok) {
        // Fallback: fetch all and filter
        const allRes = await fetch("/api/lab", { cache: "no-store" });
        if (allRes.ok) {
          const data = await allRes.json();
          const list = (data.orders ?? []) as LabOrder[];
          setOrders(list.filter((o) => o.patientId === patientId));
          setLabs(data.labs ?? []);
        }
      } else {
        const data = await res.json();
        setOrders((data.orders ?? data) as LabOrder[]);
        if (data.labs) setLabs(data.labs);
      }
      setError(null);
    } catch {
      setError("تعذّر تحميل طلبات المعمل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!labName.trim() || busy) return;
    setBusy(true);
    setError(null);

    const finalWork = workType === "أخرى (مخصص)" ? customWork.trim() || "عمل معمل مخصص" : workType;

    try {
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          labName: labName.trim(),
          workType: finalWork,
          details: details.trim() || null,
          sentDate,
          dueDate,
          cost: cost.trim() || undefined,
          costCurrency: base,
          note: note.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حفظ طلب المعمل.");
        return;
      }
      setShowAdd(false);
      setDetails("");
      setCost("");
      setNote("");
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (orderId: number, nextStatus: "received" | "delivered") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/lab/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-navy-900">أعمال وتركيبات المعمل ({orders.length})</h3>
          <p className="text-xs text-slate-500">متابعة التركيبات والتيجان والأطقم للمريض وتاريخ استلامها</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          className="rounded-xl bg-navy-800 px-3.5 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
        >
          {showAdd ? "إلغاء" : "+ طلب معمل جديد"}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
      ) : null}

      {showAdd ? (
        <form onSubmit={submitOrder} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <h4 className="text-xs font-bold text-navy-900">إرسال عمل جديد إلى المختبر</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">اسم المختبر *</span>
              <input
                value={labName}
                onChange={(e) => setLabName(e.target.value)}
                placeholder="مثال: مختبر السعادة للأسنان"
                list="patient-labs-list"
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
              <datalist id="patient-labs-list">
                {labs.map((l) => (
                  <option key={l.labName} value={l.labName} />
                ))}
              </datalist>
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">نوع العمل / التركيبة *</span>
              <select
                value={workType}
                onChange={(e) => setWorkType(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                {WORK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            {workType === "أخرى (مخصص)" ? (
              <label className="text-xs sm:col-span-2">
                <span className="mb-1 block font-bold text-slate-600">حدد نوع العمل بدقة</span>
                <input
                  value={customWork}
                  onChange={(e) => setCustomWork(e.target.value)}
                  placeholder="وصف العمل المطلوب من المعمل"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                />
              </label>
            ) : null}

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">تاريخ الإرسال</span>
              <input
                type="date"
                value={sentDate}
                onChange={(e) => setSentDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">موعد التسليم المتوقع *</span>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">رقم السن واللون (Shade & Tooth)</span>
              <input
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="مثال: سن 11 و 21، لون A2، حافة شفافة"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">تكلفة المعمل (اختياري)</span>
              <input
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="المبلغ المحتسب من المعمل"
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">ملاحظات لفني المختبر</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="تعليمات إضافية للفني..."
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
              disabled={busy || !labName.trim()}
              className="rounded-xl bg-brand-orange px-5 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            >
              حفظ وإرسال للطلب
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
          جارٍ التحميل…
        </p>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-bold text-slate-600">لا توجد طلبات معمل مسجلة لهذا المريض</p>
          <p className="mt-1 text-xs text-slate-400">
            يمكنك إرسال طلب تركيبات أو تقويم بنقرة زر ومتابعة مواعيد استلامها
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {orders.map((order) => {
            const statusConf = STATUS_MAP[order.status] ?? STATUS_MAP.sent;
            return (
              <div
                key={order.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-slate-300"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-extrabold text-navy-900">{order.workType}</span>
                      <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${statusConf.bg} ${statusConf.text}`}>
                        {statusConf.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      المختبر: <span className="font-bold text-navy-800">{order.labName}</span>
                      {order.details ? ` · التفاصيل: ${order.details}` : ""}
                    </p>
                  </div>

                  <div className="text-left text-xs">
                    <p className="font-bold text-slate-700">
                      التسليم: {friendlyDate(order.dueDate)}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      أُرسل: {friendlyDate(order.sentDate)}
                    </p>
                  </div>
                </div>

                {order.note ? (
                  <p className="mt-2 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">
                    💬 {order.note}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs">
                  <div>
                    {order.baseAmountMinor ? (
                      <span className="text-[11px] font-bold text-slate-500">
                        التكلفة: {formatMoney(order.baseAmountMinor, base)}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {order.status === "sent" ? (
                      <button
                        type="button"
                        onClick={() => void updateStatus(order.id, "received")}
                        disabled={busy}
                        className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-bold text-white transition-opacity hover:opacity-90"
                      >
                        ✓ استلام من المختبر
                      </button>
                    ) : null}

                    {order.status === "received" ? (
                      <button
                        type="button"
                        onClick={() => void updateStatus(order.id, "delivered")}
                        disabled={busy}
                        className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white transition-opacity hover:opacity-90"
                      >
                        ✓ تسليم وتركيب للمريض
                      </button>
                    ) : null}

                    <a
                      href={`/app/lab`}
                      className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
                    >
                      عرض في سجل المعامل
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
