"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { formatClinicTimestamp } from "@/lib/clinic-clock";
import { FollowupEditor } from "./FollowupEditor";
import type { readAppointmentFollowupQueue } from "@/lib/appointment-followup-db";
type Page = Awaited<ReturnType<typeof readAppointmentFollowupQueue>>;
const labels: Record<string, string> = { pending: "بانتظار المتابعة", no_answer: "لم يرد", awaiting_reply: "بانتظار الرد", rebooking_review: "مراجعة إعادة الحجز" };
const button = "min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold disabled:opacity-40";
export function FollowupAction(props: { appointmentId: number; patientId: number }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  if (!session || !["admin", "reception"].includes(session.role)) return null;
  return <div><button type="button" className={button} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "إخفاء المتابعة" : "متابعة الغياب"}</button>{open ? <FollowupEditor {...props} /> : null}</div>;
}
export function FollowupQueue({ patientId }: { patientId?: number }) {
  const session = useSession();
  const permitted = !!session && ["admin", "reception"].includes(session.role);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ session: typeof session; patientId?: number; page: Page } | null>(null);
  const [error, setError] = useState("");
  const owner = useRef(0);
  const page = state?.session === session && state.patientId === patientId ? state.page : null;
  useEffect(() => {
    const revision = ++owner.current;
    const controller = new AbortController();
    setState(null); setError("");
    if (permitted) void (async () => {
      try {
        const params = new URLSearchParams({ limit: "25" });
        if (patientId) params.set("patientId", String(patientId));
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/appointment-followups?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (owner.current !== revision || controller.signal.aborted) return;
        if (!response.ok) throw new Error(body.message ?? "تعذّر تحميل المتابعة.");
        if (!Array.isArray(body.items)) throw new Error("قائمة متابعة غير صالحة.");
        setState({ session, patientId, page: body });
      } catch (error) { if (owner.current === revision && !controller.signal.aborted) setError(error instanceof Error ? error.message : "تعذّر تحميل المتابعة."); }
    })();
    return () => { controller.abort(); };
  }, [session, patientId, permitted, cursor, reload]);
  useEffect(() => { const refresh = () => { setCursor(null); setReload(v => v + 1); }; window.addEventListener("appointment-followup-changed", refresh); return () => window.removeEventListener("appointment-followup-changed", refresh); }, []);
  if (!permitted) return null;
  return <section dir="rtl" aria-label="قائمة متابعة الغياب" className="my-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-extrabold">متابعة الغياب المفتوحة</h2><p className="text-xs text-slate-600">مهام فعلية عبر الأيام، مستقلة عن أعداد شاشة اليوم.</p></div><button className={button} onClick={() => { setCursor(null); setReload(v => v + 1); }}>تحديث المتابعة</button></div>
    {error ? <p role="alert" className="mt-3 text-sm text-amber-900">{error} القائمة غير معروفة الآن، وليست خالية.</p> : !page ? <p role="status" className="mt-3 text-sm">جارٍ تحميل المتابعة…</p> : <>
      {!page.items.length ? <p className="mt-3 text-sm">لا توجد مهام مفتوحة في هذه الصفحة. لبدء متابعة افتح موعد «لم يحضر» من ملف المريض.</p> : <ol className="mt-3 space-y-3">{page.items.map(item => <li key={item.id} data-followup-appointment={item.sourceIdentity?.appointmentId} className="rounded-xl border border-slate-200 p-3">
        <div className="flex flex-wrap justify-between gap-2"><span className="font-bold">{item.full_name ?? "مصدر غير متاح — يحتاج مراجعة"}</span><span className="text-sm">{labels[item.outcome] ?? item.outcome}{item.overdue ? " · حان موعد المتابعة" : ""}</span></div>
        <p className="my-2 text-xs">المراجعة: <time dir="ltr">{formatClinicTimestamp(String(item.due_at), page.timeZone)}</time></p>
        {item.contactBlocked || !item.sourceIdentity ? <p className="text-sm text-amber-900">تغيّر المصدر؛ لا اتصال أو إعادة حجز من هذه المهمة. التاريخ محفوظ للمراجعة.</p> : <FollowupAction appointmentId={item.sourceIdentity.appointmentId} patientId={item.sourceIdentity.expectedPatientId} />}
      </li>)}</ol>}
      <div className="mt-3 flex flex-wrap gap-2">{cursor ? <button className={button} onClick={() => setCursor(null)}>بداية القائمة</button> : null}<button className={button} disabled={!page.nextCursor} onClick={() => setCursor(page.nextCursor)}>الصفحة التالية</button></div>
      <p className="mt-2 text-xs text-slate-500">القائمة مباشرة؛ قد يتغير ترتيبها بعد تحديث موعد متابعة. حدّثها للعودة إلى البداية.</p>
    </>}
  </section>;
}
