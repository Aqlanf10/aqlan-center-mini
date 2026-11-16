"use client";

import { useState } from "react";
import { LAB_STATUS_LABEL, type LabOrderClinicalDTO, type LabOrderStatus, type LabOrderTrackingEvent } from "@/lib/lab";

/**
 * إجراءات أمر المختبر في اللوحة الموحّدة (M2 slice 67).
 *
 * كل نقلة ترسل الحالة التي يراها الشاشة (`expectedStatus`)، فلا تحرّك شاشةٌ قديمة عملًا
 * حرّكه جهاز آخر؛ الرفض يُعرض بنصّه ثم تُعاد القراءة. الإلغاء بعد الإرسال لمن يملك
 * clinical.lab.cancel وبتأكيد صريح. استكمال الإرسالية والتصحيحات والمال لم تُنقل بعد.
 */
const NEXT: Partial<Record<LabOrderStatus, { to: LabOrderStatus; label: string }[]>> = {
  sent: [{ to: "in_progress", label: "بدأ التصنيع" }, { to: "received", label: "وصل من المختبر" }],
  in_progress: [{ to: "received", label: "وصل من المختبر" }],
  received: [{ to: "delivered", label: "رُكّب للمريض" }, { to: "remake", label: "يحتاج إعادة تصنيع" }, { to: "sent", label: "أُعيد للمختبر" }],
  remake: [{ to: "received", label: "وصل بعد الإعادة" }],
  delivered: [{ to: "remake", label: "يحتاج إعادة تصنيع" }],
};
const CANCELLABLE: LabOrderStatus[] = ["needed", "sent", "in_progress", "received"];
const DUE_DATE_OPEN: LabOrderStatus[] = ["needed", "sent", "in_progress", "remake"];

export function CanonicalLabOrderActions({ order, canOrder, canCancel, onChanged }: {
  order: LabOrderClinicalDTO; canOrder: boolean; canCancel: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [due, setDue] = useState(order.dueDate);
  const [events, setEvents] = useState<LabOrderTrackingEvent[] | null>(null);

  async function patch(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/lab/${order.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        setMessage(typeof payload?.message === "string" ? payload.message : "تعذّر تنفيذ الإجراء.");
        if (response.status === 409) onChanged();
        return null;
      }
      return payload ?? {};
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
      return null;
    } finally { setBusy(false); }
  }

  async function move(to: LabOrderStatus) {
    const done = await patch({ status: to, expectedStatus: order.status, ...(note.trim() ? { note: note.trim() } : {}) });
    if (done) { setNote(""); setConfirmCancel(false); onChanged(); }
  }

  const cancellable = CANCELLABLE.includes(order.status) && (order.status === "needed" ? canOrder : canOrder && canCancel);
  const moves = canOrder ? NEXT[order.status] ?? [] : [];
  return (
    <div className="mt-2 space-y-2 border-t border-slate-100 pt-2" data-testid="lab-order-actions">
      {moves.length || cancellable ? (
        <div className="flex flex-wrap items-center gap-2">
          {moves.map(move_ => (
            <button key={move_.to} type="button" disabled={busy} onClick={() => void move(move_.to)} data-move={move_.to}
              className="min-h-10 rounded-xl bg-navy-900 px-3 text-xs font-bold text-white disabled:opacity-50">{move_.label}</button>
          ))}
          {cancellable ? (confirmCancel
            ? <button type="button" disabled={busy} onClick={() => void move("cancelled")} data-move="cancelled"
                className="min-h-10 rounded-xl bg-red-700 px-3 text-xs font-bold text-white disabled:opacity-50">تأكيد إلغاء الإرسالية</button>
            : <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)} data-testid="lab-cancel"
                className="min-h-10 rounded-xl border border-red-300 px-3 text-xs font-bold text-red-800">إلغاء…</button>) : null}
          <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-slate-700">
            <span className="shrink-0">ملاحظة</span>
            <input value={note} maxLength={300} onChange={event => setNote(event.target.value)}
              className="min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-xs" />
          </label>
        </div>
      ) : order.status === "needed" && canOrder ? (
        <p className="text-xs text-slate-600">استكمال الإرسالية قبل إرسالها لم يُنقل بعد إلى هذه اللوحة.</p>
      ) : null}
      {canOrder && DUE_DATE_OPEN.includes(order.status) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-slate-700">موعد التسليم
            <input type="date" dir="ltr" value={due} onChange={event => setDue(event.target.value)} data-testid="lab-due-input"
              className="min-h-10 rounded-xl border border-slate-300 px-2" />
          </label>
          <button type="button" disabled={busy || !due || due === order.dueDate} data-testid="lab-due-save"
            onClick={() => void patch({ dueDate: due }).then(done => { if (done) onChanged(); })}
            className="min-h-10 rounded-xl border border-slate-300 px-3 font-bold text-navy-900 disabled:opacity-50">حفظ الموعد</button>
        </div>
      ) : null}
      <button type="button" disabled={busy} className="text-xs font-bold text-sky-800 underline-offset-2 hover:underline" data-testid="lab-events"
        onClick={() => void patch({ action: "events" }).then(done => { if (done && Array.isArray(done.events)) setEvents(done.events as LabOrderTrackingEvent[]); })}>
        سجل الحركة
      </button>
      {events ? (
        <ol className="space-y-1 text-xs text-slate-700" data-testid="lab-events-list">
          {events.length === 0 ? <li>لا أحداث مسجّلة.</li> : events.map(event => (
            <li key={event.id}>
              <span dir="ltr">{event.createdAt.slice(0, 16).replace("T", " ")}</span> · {event.actor}
              {event.toStatus ? ` · ${LAB_STATUS_LABEL[event.toStatus as LabOrderStatus] ?? event.toStatus}` : ""}
              {event.notes ? ` · ${event.notes}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {message ? <p role="alert" className="text-xs text-red-800">{message}</p> : null}
    </div>
  );
}
