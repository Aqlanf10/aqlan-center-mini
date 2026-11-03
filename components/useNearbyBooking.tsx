"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { requestBookingWithConfirmation, type NearbyBookingWarning } from "@/lib/nearby-booking-request";
import { friendlyDate, friendlyTime } from "@/lib/reminders";

type Pending = { warning: NearbyBookingWarning; finish: (accepted: boolean) => void };

export function NearbyBookingDialog({ warning, onDecision }: {
  warning: NearbyBookingWarning; onDecision: (accepted: boolean) => void;
}) {
  return <Modal label="للمريض موعد قائم قريب" onClose={() => onDecision(false)} initialFocus="[data-nearby-cancel]">
    <section dir="rtl" className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-5 shadow-xl">
      <h2 className="text-lg font-black text-navy-950">للمريض موعد قائم قريب</h2>
      <p className="mt-2 text-sm text-slate-700">يوجد موعد للمريض في يوم الحجز المقترح أو خلال اليومين التاليين. هل تقصد حجز موعد إضافي؟</p>
      <ul className="my-4 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-navy-950">
        {warning.nearbyAppointments.map(appointment => <li key={appointment.id} className="flex flex-wrap gap-x-2 gap-y-1">
          <span>{friendlyDate(appointment.scheduledDate)}</span>
          <span>{friendlyTime(appointment.scheduledTime)}</span>
          <span>{appointment.doctorName ? `مع ${appointment.doctorName}` : "الطبيب غير محدد"}</span>
        </li>)}
      </ul>
      <p className="text-xs text-slate-600">التأكيد لا يتجاوز منع التداخل الفعلي أو شروط الحجز الأخرى.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" data-nearby-cancel className="min-h-11 flex-1 rounded-xl border border-slate-300 px-4 py-2 font-bold text-navy-900 hover:bg-slate-50" onClick={() => onDecision(false)}>إلغاء الحجز الجديد</button>
        <button type="button" className="min-h-11 flex-1 rounded-xl bg-navy-900 px-4 py-2 font-bold text-white hover:bg-navy-800" onClick={() => onDecision(true)}>تأكيد موعد إضافي مقصود</button>
      </div>
    </section>
  </Modal>;
}

/** One pending booking per mounted patient/workflow owner; never persist a token. */
export function useNearbyBooking(scope?: unknown) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const owner = useRef({ scope, live: true, busy: false });
  if (owner.current.scope !== scope) {
    owner.current.live = false;
    pendingRef.current?.finish(false);
    pendingRef.current = null;
    owner.current = { scope, live: true, busy: false };
  }
  useEffect(() => {
    const current = owner.current;
    current.live = true;
    return () => { current.live = false; pendingRef.current?.finish(false); pendingRef.current = null; };
  }, [scope]);
  const decide = useRef((value: Pending, accepted: boolean) => {
    if (pendingRef.current !== value) return;
    pendingRef.current = null;
    setPending(null);
    value.finish(accepted);
  }).current;
  const bookingFetch = useRef(async (url: string, init: RequestInit, stillCurrent: () => boolean = () => true) => {
    const current = owner.current;
    if (!current.live || current.busy) return new Response(JSON.stringify({ message: "طلب الحجز قيد المراجعة. لم يُرسل طلب إضافي." }), { status: 409 });
    current.busy = true;
    try {
      return await requestBookingWithConfirmation(url, init, warning => new Promise<boolean>(finish => {
        const value = { warning, finish };
        pendingRef.current = value;
        setPending(value);
      }), () => current.live && owner.current === current && stillCurrent());
    } finally { current.busy = false; }
  }).current;
  return { bookingFetch, nearbyBookingDialog: pending && pendingRef.current === pending
    ? <NearbyBookingDialog warning={pending.warning} onDecision={accepted => decide(pending, accepted)} /> : null };
}
