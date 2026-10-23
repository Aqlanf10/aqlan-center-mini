"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FollowupAction } from "@/components/appointments/FollowupQueue";
import { AppointmentReminder } from "@/components/AppointmentReminder";
import { useSession } from "@/components/SessionProvider";
import { formatClinicTimestamp } from "@/lib/clinic-clock";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import type { ManualAppointmentReminderSnapshot } from "@/lib/manual-appointment-reminder";
import {
  canRemindPatientRole, patientAppointmentId, readPatientAppointmentsPage,
  type PatientAppointmentsPage, type PatientAppointmentsView,
} from "@/lib/patient-appointments-contract";

const STATUS: Record<Appointment["status"], { label: string; style: string }> = {
  booked: { label: "محجوز", style: "border-sky-200 bg-sky-50 text-sky-800" },
  arrived: { label: "وصل", style: "border-amber-200 bg-amber-50 text-amber-900" },
  done: { label: "مكتمل", style: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  cancelled: { label: "ملغى", style: "border-rose-200 bg-rose-50 text-rose-800" },
  no_show: { label: "لم يحضر", style: "border-slate-200 bg-slate-100 text-slate-700" },
};
type Selection = { view: PatientAppointmentsView; cursor: string | null; previous: (string | null)[] };
type Owner = { patientId: number; session: ReturnType<typeof useSession>; sessionKey: string; selection: Selection; active: boolean; revision: number; abort: AbortController | null; mutation: AbortController | null; pending: boolean; page: PatientAppointmentsPage | null };
type State = { owner: Owner; phase: "loading" | "ready" | "error"; page?: PatientAppointmentsPage; message?: string; busy?: boolean };

/** Independent of financial summary loading. All records come from the canonical patient endpoint. */
export function PatientAppointmentsPanel({ patientId }: { patientId: number }) {
  const session = useSession();
  const permitted = !!session && ["admin", "reception", "doctor", "assistant"].includes(session.role)
    && patientAppointmentId(String(patientId)) === patientId;
  const sessionKey = JSON.stringify([session?.username, session?.role, session?.permissions]);
  const scope = useMemo(() => ({ patientId, session, sessionKey,
    initial: { view: "upcoming", cursor: null, previous: [] } as Selection }), [patientId, session, sessionKey]);
  const [savedSelection, saveSelection] = useState<{ scope: typeof scope; value: Selection } | null>(null);
  const selection = savedSelection?.scope === scope ? savedSelection.value : scope.initial;
  const setSelection = useCallback((value: Selection) => saveSelection({ scope, value }), [scope]);
  // Object identity retires even a replacement session with identical claims, and A → B → A.
  const owner = useMemo<Owner>(() => ({ patientId, session, sessionKey, selection, active: false, revision: 0, abort: null, mutation: null, pending: false, page: null }),
    [patientId, session, sessionKey, selection]);
  const current = useRef<Owner | null>(null);
  const [state, setState] = useState<State | null>(null);
  const ready = state?.owner === owner && state.phase === "ready" ? state : null;
  const error = state?.owner === owner && state.phase === "error" ? state.message : null;
  const isOwner = useCallback(() => current.current === owner && owner.active && permitted, [owner, permitted]);

  useLayoutEffect(() => {
    current.current = owner; owner.active = true;
    return () => { owner.active = false; owner.revision++; owner.page = null; owner.abort?.abort(); owner.mutation?.abort(); if (current.current === owner) current.current = null; };
  }, [owner]);

  const load = useCallback(async (notice?: string): Promise<boolean> => {
    if (!isOwner() || owner.pending) return false;
    const revision = ++owner.revision;
    owner.abort?.abort(); owner.abort = new AbortController(); owner.page = null;
    setState({ owner, phase: "loading", message: notice });
    const live = () => isOwner() && owner.revision === revision;
    try {
      const params = new URLSearchParams({ projection: "appointments", view: selection.view });
      if (selection.cursor !== null) params.set("cursor", selection.cursor);
      const response = await fetch(`/api/patients/${patientId}?${params}`, { cache: "no-store", signal: owner.abort.signal });
      const body: unknown = await response.json().catch(() => null);
      if (!live()) return false;
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "تعذّر تحميل المواعيد. أعد المحاولة.";
        throw new Error(message);
      }
      const page = readPatientAppointmentsPage(body, patientId, selection.view, selection.cursor);
      if (!page) throw new Error("تعذّر التحقق من بيانات المواعيد. أعد التحميل.");
      owner.page = page;
      setState({ owner, phase: "ready", page, message: notice });
      return true;
    } catch (error) {
      if (live()) setState({ owner, phase: "error", message: error instanceof Error ? error.message : "تعذّر تحميل المواعيد." });
      return false;
    }
  }, [isOwner, owner, patientId, selection]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => { if (isOwner() && !owner.pending) setSelection({ view: selection.view, cursor: null, previous: [] }); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const midnight = window.setInterval(() => {
      if (owner.page && clinicDateString(new Date(), owner.page.timeZone) !== owner.page.today) refresh();
    }, 30_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(midnight); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [isOwner, owner, selection.view, setSelection]);

  const page = ready?.page;
  const currentPage = () => isOwner() && !!page && owner.page === page && !owner.pending;
  const confirmReminder = async (item: Appointment, snapshot: ManualAppointmentReminderSnapshot) => {
    if (!currentPage() || !page?.canRemind || !canRemindPatientRole(session?.role) || snapshot.patientId !== patientId
      || !page.appointments.includes(item) || (item.status !== "booked" && item.status !== "no_show")) return;
    owner.pending = true; owner.mutation = new AbortController();
    setState({ owner, phase: "ready", page, busy: true });
    let recorded = false;
    let notice = "لم نتمكن من تأكيد تسجيل التذكير. راجع حالة الموعد بعد التحديث قبل إعادة المحاولة.";
    try {
      const response = await fetch(`/api/appointments/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, signal: owner.mutation.signal,
        body: JSON.stringify({ action: "reminded", snapshot }),
      });
      const body = await response.json().catch(() => null);
      if (!isOwner()) return;
      recorded = response.ok && body?.ok === true;
      if (!recorded && typeof body?.message === "string") notice = body.message;
    } catch { /* A lost response is unknown; only a fresh read may show a recorded stamp. */ }
    finally {
      owner.pending = false;
      if (isOwner()) await load(recorded ? "سُجّلت إفادتك بالتذكير. هذا ليس إثبات تسليم آلي." : notice);
    }
  };

  if (!permitted) return null;
  return (
    <section aria-label="مواعيد المريض" data-testid="patient-appointments-panel" dir="rtl" className="mb-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-4 sm:px-5">
        <div><h2 className="text-base font-extrabold text-navy-900">مواعيد المريض</h2><p className="mt-1 text-xs text-slate-500">سجل المواعيد المعتمد، بترتيب الموعد وتوقيت العيادة</p></div>
        <button type="button" onClick={() => { if (isOwner() && !owner.pending) setSelection({ view: selection.view, cursor: null, previous: [] }); }} disabled={ready?.busy} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-xs font-bold text-slate-700 disabled:opacity-40">تحديث المواعيد</button>
      </div>
      <div className="flex flex-wrap gap-2 p-4" role="group" aria-label="عرض المواعيد">
        {([ ["upcoming", "اليوم والقادمة"], ["history", "السابقة والمغلقة"] ] as const).map(([view, label]) => (
          <button type="button" key={view} aria-pressed={selection.view === view} disabled={ready?.busy}
            onClick={() => { if (isOwner() && !owner.pending && selection.view !== view) setSelection({ view, cursor: null, previous: [] }); }}
            className={`min-h-11 rounded-xl px-4 text-sm font-bold disabled:opacity-40 ${selection.view === view ? "bg-navy-900 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{label}</button>
        ))}
      </div>
      {error ? <div role="alert" data-testid="patient-appointments-error" className="mx-4 mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}<p className="mt-1 text-xs">القائمة غير معروفة الآن، وليست خالية. استخدم «تحديث المواعيد» لإعادة المحاولة.</p></div>
        : !page ? <p role="status" className="px-5 pb-5 text-sm text-slate-500">جارٍ التحقق من مواعيد المريض…</p>
        : <>
          {ready?.message ? <p role="status" data-testid="patient-appointments-notice" className="mx-4 mb-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">{ready.message}</p> : null}
          <p className="px-5 pb-3 text-xs text-slate-500">{selection.view === "upcoming" ? "محجوزة أو وصل صاحبها، من اليوم فصاعدًا. الأقرب أولًا." : "المواعيد قبل اليوم، وكل موعد مكتمل أو ملغى أو لم يحضر صاحبه. الأحدث أولًا."} اليوم المعتمد: <span dir="ltr">{page.today}</span></p>
          {page.appointments.length === 0 ? <p className="mx-4 mb-4 rounded-xl border border-dashed border-slate-200 p-5 text-sm text-slate-500">{selection.cursor ? "لا توجد مواعيد أخرى بعد هذه الصفحة. حدّث القائمة لمراجعة أي تغييرات." : selection.view === "upcoming" ? "لا توجد مواعيد لليوم أو قادمة في هذا العرض." : "لا توجد مواعيد سابقة أو مغلقة في هذا العرض."}</p>
            : <ol className="space-y-3 px-4 pb-4">
              {page.appointments.map(item => <li key={item.id} data-patient-appointment={item.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><time dateTime={`${item.scheduledDate}T${item.scheduledTime}`} className="font-extrabold text-navy-900"><span dir="ltr">{item.scheduledDate}</span> · {friendlyTime(item.scheduledTime)}</time><p className="mt-1 text-xs text-slate-500">{friendlyDateLong(item.scheduledDate)}</p></div>
                  <span className={`rounded-full border px-3 py-1 text-xs font-bold ${STATUS[item.status].style}`}>{item.status === "booked" && item.scheduledDate < page.today ? "محجوز سابق لم يُغلق" : STATUS[item.status].label}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600"><span>الطبيب: {item.doctorName || "غير مسند"}</span><span>المدة: {item.durationMinutes} دقيقة</span></div>
                {item.status === "no_show" ? <div className="mt-3"><FollowupAction appointmentId={item.id} patientId={patientId} /></div> : null}
                {item.status === "cancelled" ? <p className="mt-2 break-words text-xs text-rose-800">سبب الإلغاء: {item.cancelReason || "لم يُسجّل سبب"}</p> : null}
                {page.canRemind && canRemindPatientRole(session?.role) ? <div className="mt-3"><AppointmentReminder item={item} clinicTimeZone={page.timeZone} busy={!!ready?.busy} isCurrent={currentPage} onConfirmed={snapshot => confirmReminder(item, snapshot)} /></div> : null}
              </li>)}
            </ol>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            <span>آخر تحقق: {formatClinicTimestamp(page.generatedAt, page.timeZone)}<br />{page.appointments.length} موعد في هذه الصفحة{page.nextCursor ? "، توجد مواعيد أخرى" : " · نهاية هذا العرض"}</span>
            <div className="flex gap-2">
              {selection.previous.length ? <button type="button" disabled={ready?.busy} className="min-h-11 rounded-lg border border-slate-200 px-3 font-bold disabled:opacity-40" onClick={() => { if (currentPage()) setSelection({ view: selection.view, cursor: selection.previous.at(-1) ?? null, previous: selection.previous.slice(0, -1) }); }}>الصفحة السابقة</button> : null}
              {page.nextCursor ? <button type="button" disabled={ready?.busy} className="min-h-11 rounded-lg border border-slate-200 px-3 font-bold disabled:opacity-40" onClick={() => { if (currentPage()) setSelection({ view: selection.view, cursor: page.nextCursor, previous: [...selection.previous, selection.cursor] }); }}>المزيد من المواعيد</button> : null}
            </div>
          </div>
        </>}
    </section>
  );
}
