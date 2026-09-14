"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  PERIOD_LABEL, URGENCY_LABEL, WAITING_STATUS_LABEL, describeWindow,
  type WaitingEntry,
} from "@/lib/waiting-list";

/**
 * قائمة الانتظار — من لم يجد موعدًا.
 *
 * المحرّك يرفض الحجز حين يمتلئ اليوم، والرفضُ بلا وجهةٍ يعني مريضًا ضاع: تقول
 * له الاستقبال «لا يوجد مكان» فيُغلق الهاتف، ثم يُلغي مريضٌ آخر موعده بعد
 * ساعتين فيبقى الكرسي فارغًا ولا أحد يعرف من يُنادى.
 *
 * وهذه الشاشة أداةُ عملٍ لا تقرير: ترتيبٌ بالإلحاح ثم بأقدم من انتظر، ورقمُ
 * هاتفٍ ظاهرٌ للاتصال، وزرّان — «نودي» و«أُغلق». والحجزُ نفسه يتمّ من شاشة
 * المواعيد كأيّ حجز: **القائمة تقترح ولا تحجز**.
 */

const URGENCY_STYLE: Record<string, string> = {
  urgent: "border-red-300 bg-red-50 text-red-800",
  soon: "border-amber-300 bg-amber-50 text-amber-800",
  normal: "border-slate-200 bg-slate-50 text-slate-700",
};

export default function WaitingListPage() {
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [closing, setClosing] = useState<{ id: number; reason: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/waiting-list", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تحميل قائمة الانتظار.");
        return;
      }
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: number, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/waiting-list/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تنفيذ الإجراء.");
        return;
      }
      setError(null);
      setClosing(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5" dir="rtl">
      <PageHeader
        title="قائمة الانتظار"
        subtitle="من طلب موعدًا ولم يجد مكانًا — يُنادى حين يشغر"
      />

      {error && (
        <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-600">جارٍ التحميل…</p>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-bold text-navy-900">لا أحد ينتظر.</p>
          <p className="mt-1 text-xs text-slate-600">
            حين يمتلئ يومٌ ويُردّ مريض، تظهر له هنا إضافةٌ من شاشة الحجز نفسها.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-waiting-entry={entry.id}
              data-urgency={entry.urgency}
              className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-black text-navy-900">{entry.patientName}</span>
                    <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold ${URGENCY_STYLE[entry.urgency] ?? URGENCY_STYLE.normal}`}>
                      {URGENCY_LABEL[entry.urgency]}
                    </span>
                    {entry.status === "offered" && (
                      <span className="rounded-lg border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-800">
                        {WAITING_STATUS_LABEL.offered}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-600">
                    {entry.patientPhone ? (
                      <a href={`tel:${entry.patientPhone}`} dir="ltr" className="font-bold text-navy-800 underline">
                        {entry.patientPhone}
                      </a>
                    ) : "بلا رقم"}
                    {" · "}{entry.serviceName ?? "إجراء عام"}
                    {entry.doctorName ? ` · د. ${entry.doctorName}` : ""}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-600">
                    {describeWindow(entry)} · {PERIOD_LABEL[entry.preferredPeriod]}
                    {entry.durationMinutes ? ` · ${entry.durationMinutes} دقيقة` : ""}
                  </p>
                  {entry.note && (
                    <p className="mt-1 text-[11px] text-slate-700">{entry.note}</p>
                  )}
                </div>

                <div className="flex shrink-0 gap-1.5">
                  {entry.status === "waiting" && (
                    <button
                      type="button"
                      data-action="offer"
                      disabled={busyId === entry.id}
                      onClick={() => void act(entry.id, { action: "offer" })}
                      className="rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                    >
                      نوديَ
                    </button>
                  )}
                  <button
                    type="button"
                    data-action="booked"
                    disabled={busyId === entry.id}
                    onClick={() => void act(entry.id, { action: "booked" })}
                    className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                  >
                    حُجز له
                  </button>
                  <button
                    type="button"
                    data-action="close"
                    disabled={busyId === entry.id}
                    onClick={() => setClosing({ id: entry.id, reason: "" })}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    إغلاق
                  </button>
                </div>
              </div>

              {closing?.id === entry.id && (
                <div className="mt-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                  <label htmlFor={`reason-${entry.id}`} className="mb-1 block text-[11px] font-bold text-slate-700">
                    سبب الإغلاق — يُسأل عنه حين يتّصل المريض بعد شهرٍ يسأل عن دوره
                  </label>
                  <input
                    id={`reason-${entry.id}`}
                    type="text"
                    value={closing.reason}
                    onChange={(event) => setClosing({ id: entry.id, reason: event.target.value })}
                    placeholder="مثال: اعتذر المريض · عولج في مكانٍ آخر"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                  />
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      data-action="confirm-close"
                      disabled={busyId === entry.id || !closing.reason.trim()}
                      onClick={() => void act(entry.id, { action: "cancelled", reason: closing.reason })}
                      className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                    >
                      تأكيد الإغلاق
                    </button>
                    <button
                      type="button"
                      onClick={() => setClosing(null)}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                    >
                      تراجع
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
        القائمة تقترح ولا تحجز: الحجز يتمّ من شاشة المواعيد كأيّ حجز، فيمرّ من محرّك
        السعة نفسه. وموعدٌ يُفرض على مريضٍ لم يؤكّد هو وعدٌ لا يستطيع المركز الوفاء به.
      </p>
    </div>
  );
}
