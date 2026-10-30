"use client";

import { CanonicalOrthoDetail } from "./CanonicalOrthoDetail";
import { useEffect, useId, useState } from "react";
import { APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, PHASE_LABEL, usesArchwires, type OrthoCaseSummaryFeed } from "@/lib/ortho";

/** Read-only summary. Opening this section never mounts legacy editors or requests
 * their plan, image, assessment or financial endpoints. */
export function CanonicalOrthoCases({ patientId }: { patientId: string }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<OrthoCaseSummaryFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear();
      if (document.visibilityState === "hidden") return;
      const request = sequence;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/ortho?patientId=${encodeURIComponent(patientId)}`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل حالات التقويم.");
        if (payload?.projection !== "case-summary" || !Array.isArray(payload.cases)
          || payload.cases.some((row: { patientId?: unknown }) => row.patientId !== Number(patientId))) {
          throw new Error("تعذّر التحقق من قائمة الحالات. أعد تحميلها.");
        }
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل الحالات.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, refresh]);

  return <section aria-label="حالات التقويم" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-navy-900">حالات التقويم</h2>
      <button type="button" aria-expanded={open} aria-controls={regionId}
        onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق الحالات" : "عرض حالات التقويم"}</button>
    </div>
    {open ? <div id={regionId} className="mt-3 space-y-3" data-testid="canonical-ortho-cases">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">ملخص الحالة والطبيب المسؤول والأسلاك المسجلة.</p>
        <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(value => value + 1); }}
          className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث الحالات</button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status" className="text-sm text-slate-500">جارٍ تحميل الحالات…</p>
        : feed.cases.length === 0 ? <p className="text-sm text-slate-600">لا توجد حالات تقويم مسجلة لهذا المريض.</p>
          : <ul className="space-y-3">{feed.cases.map(row => <li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-3 text-sm [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-bold text-navy-900">{APPLIANCE_LABEL[row.appliance]} — {ARCHES_LABEL[row.arches]}</h3>
              <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold">{CASE_STATUS_LABEL[row.status]}</span>
            </div>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">الطبيب المسؤول</dt><dd>{row.responsibleDoctorName ?? "غير مسجل"}</dd></div>
              <div><dt className="text-xs text-slate-500">المرحلة المسجلة</dt><dd>{PHASE_LABEL[row.phase]}</dd></div>
              <div><dt className="text-xs text-slate-500">بداية العلاج</dt><dd dir="ltr">{row.startDate}</dd></div>
              <div><dt className="text-xs text-slate-500">المدة المخططة</dt><dd>{row.plannedMonths} شهرًا</dd></div>
              {usesArchwires(row.appliance) ? <>
                <div><dt className="text-xs text-slate-500">السلك العلوي المسجل</dt><dd dir="ltr">{row.upperWire ?? "—"}</dd></div>
                <div><dt className="text-xs text-slate-500">السلك السفلي المسجل</dt><dd dir="ltr">{row.lowerWire ?? "—"}</dd></div>
              </> : null}
            </dl>
            {row.baselineKind === "legacy" ? <p className="mt-2 text-xs text-slate-600">علاج بدأ قبل النظام</p> : null}
            <CanonicalOrthoDetail patientId={patientId} caseId={row.id} />
          </li>)}</ul>}
      {feed?.hasMore ? <p role="status" className="text-sm text-amber-800">تظهر أحدث 300 حالة فقط؛ هذه ليست القائمة الكاملة.</p> : null}
    </div> : null}
  </section>;
}
