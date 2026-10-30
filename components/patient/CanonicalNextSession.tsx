"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../SessionProvider";
import { useReturnBookingContext } from "../useReturnBookingContext";
import { useNearbyBooking } from "../useNearbyBooking";
import { addDays, clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { MAX_DURATION, MIN_DURATION } from "@/lib/appointment-services";

export function CanonicalNextSession({ visitId, patientId }: { visitId: number; patientId: number }) {
  const session = useSession();
  if (!session?.canonical || !(session.isOwner || session.capabilities?.includes("appointments.create"))
    || !session.isOwner && (session.patientScope === "none" || session.appointmentScope === "none")) return null;
  return <NextSessionForm key={JSON.stringify([session, visitId, patientId])} visitId={visitId} patientId={patientId} username={session.username} />;
}
function NextSessionForm({ visitId, patientId, username }: { visitId: number; patientId: number; username: string }) {
  const uid = useId();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false);
  const [date, setDate] = useState(() => addDays(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), 28));
  const [time, setTime] = useState("10:00"), [duration, setDuration] = useState(30);
  const [message, setMessage] = useState(""), [saved, setSaved] = useState(false);
  const [uncertain, setUncertain] = useState(false), [checked, setChecked] = useState(false);
  const live = useRef(true), active = useRef(false), request = useRef<AbortController | null>(null);
  const proposal = useRef<{ date: string; time: string; doctorId: number; durationMinutes: number } | null>(null);
  // Tab-local recovery metadata only: no patient name, phone, context token or
  // authority. A reload while POST is in flight must not silently unlock retry.
  const recoveryKey = `aqlan.next-session.uncertain:${username}:${patientId}:${visitId}`;
  const clearRecovery = () => { try { sessionStorage.removeItem(recoveryKey); } catch { /* in-memory gate remains */ } };
  const context = useReturnBookingContext({ patientId, source: { kind: "visit", id: visitId }, enabled: open && !denied && !saved && !uncertain, locked: busy });
  const { bookingFetch, nearbyBookingDialog } = useNearbyBooking(JSON.stringify([visitId, patientId, date, time, duration, context.fingerprint]));
  useEffect(() => {
    live.current = true;
    try {
      const saved = sessionStorage.getItem(recoveryKey);
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p?.date === "string" && typeof p?.time === "string" && Number.isSafeInteger(p?.doctorId) && Number.isInteger(p?.durationMinutes)) {
          proposal.current = p;
          // Recover an external pending-command marker after hydration.
          setOpen(true); setUncertain(true); setMessage("لم تتأكد نتيجة طلب سابق. تحقّق من المواعيد قبل محاولة جديدة.");
        }
      }
    } catch { /* Browser storage may be unavailable; current mounted gate still applies. */ }
    return () => { live.current = false; request.current?.abort(); };
  }, [recoveryKey]);
  const book = async () => {
    if (active.current || denied || uncertain || saved || !context.ready || !context.isCurrent() || !context.verified) return;
    active.current = true; setBusy(true); setMessage("");
    proposal.current = { date, time, durationMinutes: duration, doctorId: context.verified.doctorId };
    try { sessionStorage.setItem(recoveryKey, JSON.stringify(proposal.current)); } catch { /* in-memory recovery still applies */ }
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await bookingFetch(`/api/visits/${visitId}/next`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, time, durationMinutes: duration, ...context.intrinsicPayload }), signal: controller.signal }, () => live.current && context.isCurrent());
      const payload = await response.json().catch(() => null);
      if (!live.current) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) { clearRecovery(); setDenied(true); setMessage("انتهت الجلسة أو تغيّرت صلاحية الوصول. حدّث الملف قبل الحجز."); return; }
      if (response.status >= 500 || response.ok && !(Number.isSafeInteger(payload?.appointmentId) && payload.appointmentId > 0 && payload.patientId === patientId && payload.doctorId === proposal.current.doctorId)) throw new Error("uncertain booking");
      if (!response.ok) { clearRecovery(); context.handleRejection(payload); setMessage(payload?.message ?? "تعذّر الحجز. راجع البيانات قبل المحاولة."); return; }
      clearRecovery();
      setSaved(true); setMessage(`حُجزت الجلسة القادمة مع ${payload.doctorName} — ${date} ${time}.`);
    } catch {
      if (live.current) { setUncertain(true); setChecked(false); setMessage("لم تتأكد نتيجة الحجز؛ لا تعِد الطلب قبل مراجعة المواعيد."); }
    } finally { clearTimeout(timer); if (live.current) { active.current = false; setBusy(false); } }
  };
  const verify = async () => {
    if (active.current || !proposal.current) return;
    active.current = true; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/patients/${patientId}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!live.current) return;
      if ([401, 403, 404].includes(response.status)) { setDenied(true); setMessage("تعذّر التحقق من الوصول. حدّث الجلسة والملف."); return; }
      if (!response.ok || payload?.patient?.id !== patientId || !Array.isArray(payload.appointments)) throw new Error("unverified appointments");
      const p = proposal.current;
      const found = payload.appointments.some((a: { scheduledDate?: string; scheduledTime?: string; doctorId?: number; durationMinutes?: number; status?: string }) =>
        a.scheduledDate === p.date && a.scheduledTime === p.time && a.doctorId === p.doctorId && a.durationMinutes === p.durationMinutes && !["cancelled", "no_show"].includes(a.status ?? ""));
      setSaved(found); setChecked(!found);
      if (found) clearRecovery();
      setMessage(found ? "يوجد موعد مطابق في الملف. راجعه في المواعيد؛ لم يُرسل حجز جديد." : "لم يظهر موعد مطابق في القراءة الحالية. راجع المواعيد قبل اتخاذ قرار حجز جديد.");
    } catch { if (live.current) setMessage("تعذّر التحقق من النتيجة. راجع المواعيد قبل أي محاولة جديدة."); }
    finally { clearTimeout(timer); if (live.current) { active.current = false; setBusy(false); } }
  };
  return <div className="w-full min-w-0 max-w-full" data-testid={`next-session-${visitId}`}>
    {!open ? <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800" onClick={() => setOpen(true)}>حجز الجلسة القادمة</button> : null}
    {open && !denied && !saved && !uncertain ? <div className="mt-2 space-y-3 rounded-xl border border-slate-200 p-3">
      {context.view}
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        <label htmlFor={`${uid}-date`} className="min-w-0 text-xs font-bold">التاريخ<input id={`${uid}-date`} type="date" value={date} disabled={busy} onChange={e => setDate(e.target.value)} className="mt-1 block min-h-11 w-full min-w-0 max-w-full rounded-lg border p-2" /></label>
        <label htmlFor={`${uid}-time`} className="min-w-0 text-xs font-bold">الوقت<input id={`${uid}-time`} type="time" value={time} disabled={busy} onChange={e => setTime(e.target.value)} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border p-2" /></label>
        <label htmlFor={`${uid}-duration`} className="min-w-0 text-xs font-bold">المدة بالدقائق<input id={`${uid}-duration`} type="number" min={MIN_DURATION} max={MAX_DURATION} value={duration} disabled={busy} onChange={e => setDuration(Number(e.target.value))} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border p-2" /></label>
      </div>
      <button type="button" disabled={busy || !context.ready} onClick={() => void book()} className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">تأكيد حجز الجلسة القادمة</button>
    </div> : null}
    {nearbyBookingDialog}
    {message ? <p role={saved ? "status" : "alert"} className="mt-2 text-sm font-bold text-navy-800">{message}</p> : null}
    {uncertain && !denied && !saved ? <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void verify()} className="min-h-11 rounded-xl border px-3 text-sm font-bold">تحقق من نتيجة الحجز</button>
      {checked ? <button type="button" disabled={busy} onClick={() => { clearRecovery(); setUncertain(false); setChecked(false); setMessage(""); context.refresh(); }} className="min-h-11 rounded-xl border px-3 text-sm font-bold">راجعت المواعيد وأريد محاولة جديدة</button> : null}
    </div> : null}
  </div>;
}
