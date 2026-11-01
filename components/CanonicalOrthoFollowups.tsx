"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "./PageHeader";
import { BUCKET_LABEL, BUCKET_ORDER, sinceAdjustmentText, type FollowupBucket, type NextAppointmentInfo } from "@/lib/ortho-followup";
import { CLINICAL_FOLLOWUP_BUCKETS, isCanonicalOrthoFollowups, type CanonicalOrthoFollowups as Feed } from "@/lib/canonical-ortho-followup-projection";

const label = (bucket: FollowupBucket) => bucket === "no_show" ? "غياب مسجّل سابقًا" : bucket === "no_appointment" ? "بلا موعد متابعة دورية مؤكّد" : BUCKET_LABEL[bucket];
function Booking({ appointment, title }: { appointment: NextAppointmentInfo; title: string }) {
  return <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs"><p className="font-bold">{title}</p>
    <p><bdi>{appointment.date} · {appointment.time}</bdi>{appointment.doctorName ? ` — ${appointment.doctorName}` : ""}</p>
    {appointment.serviceName ? <p>{appointment.serviceName}</p> : null}</div>;
}
export function CanonicalOrthoFollowups() {
  const [feed, setFeed] = useState<Feed | null>(null), [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [active, setActive] = useState<FollowupBucket | "all">("all");
  useEffect(() => {
    let alive = true, sequence = 0; let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear(); if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch("/api/ortho/followups", { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل متابعة التقويم.");
        if (!isCanonicalOrthoFollowups(payload)) throw new Error("تعذّر التحقق من بيانات المتابعة. أعد تحميلها.");
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل المتابعة.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const allowedBuckets = BUCKET_ORDER.filter(bucket => feed?.appointmentCoverage === "none" ? CLINICAL_FOLLOWUP_BUCKETS.includes(bucket)
    : feed?.appointmentCoverage === "own" ? bucket !== "no_appointment" : true);
  const selected = active !== "all" && allowedBuckets.includes(active) ? active : "all";
  const rows = feed?.rows.filter(row => selected === "all" || row.buckets.includes(selected)) ?? [];
  return <div data-testid="canonical-ortho-followups" className="space-y-4 [overflow-wrap:anywhere]">
    <PageHeader title="متابعة التقويم" subtitle="متابعة الحالات الجارية ضمن نطاق مرضاك." />
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">الأعداد تخص الحالات المعروضة في هذه القراءة فقط.</p>
      <button type="button" className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-navy-800" onClick={() => { setFeed(null); setError(null); setRefresh(n => n + 1); }}>تحديث المتابعة</button></div>
    {error ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p> : !feed ? <p role="status">جارٍ تحميل المتابعة…</p> : <>
      {feed.appointmentCoverage === "none" ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">صلاحية التقويم لا تمنح تفاصيل المواعيد. تظهر المتابعة السريرية فقط؛ لا نستنتج وجود موعد أو غيابه.</p>
        : feed.appointmentCoverage === "own" ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">المواعيد والغياب المسجّل تخص الطبيب المرتبط بحسابك فقط. قد توجد مواعيد أخرى لا يشملها نطاقك؛ لا نستنتج غياب موعد للمريض.</p>
          : <p className="text-xs text-slate-600">«بلا موعد متابعة دورية مؤكّد» لا تعني عدم وجود حجوزات أخرى أو حجوزات تحتاج مراجعة. الغياب المعروض واقعة مسجّلة سابقة.</p>}
      {feed.hasMore ? <p role="status" className="text-sm font-bold text-amber-800">تظهر أول 300 حالة جارية حسب تاريخ بدء الحالة؛ القائمة والأعداد غير كاملة.</p> : null}
      <nav aria-label="فئات متابعة التقويم" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={selected === "all"} className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm" onClick={() => setActive("all")}>الحالات المعروضة ({feed.rows.length})</button>
        {allowedBuckets.map(bucket => <button type="button" key={bucket} aria-pressed={selected === bucket} onClick={() => setActive(bucket)} className="min-h-11 rounded-xl border border-navy-200 bg-white px-3 text-sm text-navy-900">{label(bucket)} ({feed.rows.filter(row => row.buckets.includes(bucket)).length})</button>)}
      </nav>
      {rows.length === 0 ? <p className="rounded-xl border border-slate-200 bg-white p-4">لا توجد حالات ضمن الفئة المعروضة.</p> : <ul className="grid gap-3 lg:grid-cols-2">{rows.map(row => <li key={row.caseId} data-testid="canonical-ortho-followup-row" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
        <Link href={`/patients/${row.patientId}`} className="font-bold text-navy-900 underline underline-offset-4">{row.patientName}</Link>
        <p className="mt-2 text-sm">{row.status === "retention" ? "التثبيت" : "العلاج الجاري"} · آخر شدّة: {row.lastAdjustmentDate ? sinceAdjustmentText(row.daysSinceLast) : "لم تُسجّل شدّة بعد"}</p>
        <p className="text-xs text-slate-600">الاستحقاق وفق فترة المتابعة المسجلة: <bdi>{row.dueDate}</bdi> · {row.nextWeeks} أسابيع</p>
        <p className="mt-2 text-xs text-amber-800">{row.buckets.map(label).join(" · ")}</p>
        {row.schedule?.nextAppointment ? <Booking appointment={row.schedule.nextAppointment} title="المتابعة الدورية القادمة" /> : null}
        {row.schedule?.pastUnresolvedAppointment ? <Booking appointment={row.schedule.pastUnresolvedAppointment} title="موعد متابعة مضى ولم يُغلق" /> : null}
        {row.schedule?.reviewAppointments.map(appointment => <Booking key={appointment.id} appointment={appointment} title="حجز يحتاج مراجعة ارتباطه بالمتابعة" />)}
        {row.schedule?.otherAppointments.map(appointment => <Booking key={appointment.id} appointment={appointment} title="حجز آخر ضمن نطاقك" />)}
      </li>)}</ul>}
    </>}
  </div>;
}
