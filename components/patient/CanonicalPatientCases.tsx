"use client";

import { useEffect, useId, useState } from "react";
import { isCanonicalPatientCases, type CanonicalPatientCases as CaseFeed } from "@/lib/canonical-case-projection";
import { CASE_STATUS_LABEL, DEPENDENCY_REQUIREMENT_LABEL, PROBLEM_STATUS_LABEL, SPECIALTY_LABEL } from "@/lib/cases";
import { PLAN_STATUS_LABEL } from "@/lib/plans";
import { CanonicalPlanCaseEditor } from "./CanonicalPlanCaseEditor";
import { CanonicalPlanDependencyEditor } from "./CanonicalPlanDependencyEditor";
import { CanonicalProblemCreateEditor } from "./CanonicalProblemCreateEditor";
import { CanonicalProblemStatusEditor } from "./CanonicalProblemStatusEditor";
import { CanonicalCaseStatusEditor } from "./CanonicalCaseStatusEditor";

const itemStatus: Record<string, string> = { planned: "مخطط", in_progress: "بدأ علاجه", done: "منفذ", cancelled: "ملغى" };
const specialty = (key: string) => SPECIALTY_LABEL[key as keyof typeof SPECIALTY_LABEL] ?? key;

export function CanonicalPatientCases({ patientId, canEdit, canDocument, ownerKey }: { patientId: string; canEdit: boolean; canDocument: boolean; ownerKey: string }) {
  const region = useId();
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<CaseFeed | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear(); if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store", signal: current.signal });
        const body = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw Error(body?.message ?? "تعذّر تحميل الحالات وترتيب الخطة.");
        if (!isCanonicalPatientCases(body, Number(patientId))) throw Error("تعذّر التحقق من الحالات واعتماديات الخطة. أعد تحميلها.");
        setFeed(body);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل الحالات.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, refresh]);
  return <section aria-label="الحالات وترتيب الخطة" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-navy-900">الحالات وترتيب الخطة</h2>
      <button type="button" aria-expanded={open} aria-controls={region} onClick={() => { setFeed(null); setError(null); setOpen(v => !v); }}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق الحالات وترتيب الخطة" : "عرض الحالات وترتيب الخطة"}</button>
    </div>
    {open ? <div id={region} data-testid="canonical-patient-cases" className="mt-3 space-y-3 [overflow-wrap:anywhere]">
      <p className="text-xs text-slate-600">الحالات والمشاكل والروابط السريرية المسجلة. حالة العلاج لا تثبت التغطية المالية أو استحقاق عمولة.</p>
      <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(v => v + 1); }} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث الحالات وترتيب الخطة</button>
      {canEdit ? <CanonicalPlanCaseEditor key={`${ownerKey}:${patientId}`} patientId={patientId} ownerKey={ownerKey} feed={feed}
        refresh={() => { setFeed(null); setError(null); setRefresh(v => v + 1); }} /> : null}
      {canEdit ? <CanonicalPlanDependencyEditor key={`dependency:${ownerKey}:${patientId}`} patientId={patientId} ownerKey={ownerKey} feed={feed}
        refresh={() => { setFeed(null); setError(null); setRefresh(v => v + 1); }} /> : null}
      {canDocument ? <CanonicalProblemCreateEditor patientId={patientId} ownerKey={ownerKey} feed={feed} refresh={() => setRefresh(v => v + 1)} /> : null}
      {canDocument ? <CanonicalProblemStatusEditor patientId={patientId} ownerKey={ownerKey} feed={feed} refresh={() => setRefresh(v => v + 1)} /> : null}
      {canEdit ? <CanonicalCaseStatusEditor key={`case-status:${ownerKey}:${patientId}`} patientId={patientId} ownerKey={ownerKey} feed={feed}
        refresh={() => { setFeed(null); setError(null); setRefresh(v => v + 1); }} /> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ تحميل الحالات…</p> : <>
        {!feed.orthoVisible ? <p className="text-xs text-slate-600">حالات التقويم غير معروضة دون صلاحية التقويم المستقلة.</p> : null}
        <h3 className="text-sm font-bold">الحالات التخصصية</h3>
        {feed.cases.length === 0 ? <p className="text-sm">لا توجد حالات ضمن هذا العرض.</p> : feed.cases.map(c => <article key={`${c.kind}:${c.id ?? c.orthoCaseId}`} data-testid="canonical-patient-case" className="rounded-xl border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><h4 className="font-bold text-navy-900">{c.title}</h4><span>{CASE_STATUS_LABEL[c.status]}</span></div>
          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-slate-500">التخصص</dt><dd>{specialty(c.specialty)}</dd></div>
            <div><dt className="text-slate-500">موضع العلاج</dt><dd>{c.site ?? "غير مسجل"}</dd></div>
            <div><dt className="text-slate-500">الطبيب المسؤول</dt><dd>{c.responsibleName ?? "غير مسجل"}</dd></div>
            <div><dt className="text-slate-500">بداية الحالة</dt><dd dir="ltr">{c.startedOn}</dd></div>
          </dl>
          {c.problem ? <p className="mt-2 whitespace-pre-wrap">{c.problem}</p> : null}
          {c.outcome ? <p className="mt-2 whitespace-pre-wrap">النتيجة المسجلة: {c.outcome}</p> : null}
          {c.completedAt ? <p className="mt-2 text-xs">تاريخ الإنهاء المسجل: <bdi>{c.completedAt.slice(0, 10)}</bdi></p> : null}
        </article>)}
        <h3 className="text-sm font-bold">المشاكل المسجلة</h3>
        {feed.problems.length === 0 ? <p className="text-sm">لا توجد مشاكل مسجلة.</p> : <ul className="space-y-2">{feed.problems.map(p => <li key={p.id} className="rounded-lg bg-slate-50 p-3 text-sm">
          <span className="font-bold">{p.label}</span> — {PROBLEM_STATUS_LABEL[p.status]}{p.site ? ` · ${p.site}` : ""}
          <p className="mt-1 text-xs text-slate-600">سجّلها {p.notedBy} · <bdi>{p.notedAt.slice(0, 10)}</bdi></p>
        </li>)}</ul>}
        <h3 className="text-sm font-bold">ترتيب بنود الخطط واعتمادياتها</h3>
        {!feed.planVisible ? <p className="text-sm">عرض بنود الخطط يحتاج صلاحية عرض الخطط المستقلة.</p> : feed.items.length === 0 ? <p className="text-sm">لا توجد بنود خطط مسجلة.</p> : <ul className="space-y-2">{feed.items.map(item => <li key={item.id} data-testid="canonical-case-item" className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><h4 className="font-bold">{item.serviceName}</h4><span>{itemStatus[item.status]}</span></div>
          <p className="mt-1 text-xs">{item.planTitle} · {PLAN_STATUS_LABEL[item.planStatus as keyof typeof PLAN_STATUS_LABEL]}</p>
          <p className="mt-1 text-xs">الأولوية: {item.priority ?? "غير مسجلة"} · الحالة: {feed.cases.find(c => c.id === item.caseId && c.kind === "specialty")?.title ?? "غير مرتبطة أو غير معروضة"}</p>
          {item.doctorName ? <p className="mt-1 text-xs">طبيب البند: {item.doctorName}</p> : null}
          {item.toothCode ? <p className="mt-1 text-xs">السن: {item.toothCode}{item.surfaces ? ` · ${item.surfaces}` : ""}</p> : null}
          {feed.dependencies.filter(d => d.itemId === item.id).map(d => <div key={d.requiresItemId} className="mt-2 border-t border-slate-200 pt-2 text-xs">
            <p>يتطلب: {feed.items.find(i => i.id === d.requiresItemId)?.serviceName} — {DEPENDENCY_REQUIREMENT_LABEL[d.requirement]} · {d.met ? "متحقق" : "لم يتحقق"}</p>
            {d.note ? <p className="mt-1 whitespace-pre-wrap">{d.note}</p> : null}
          </div>)}
        </li>)}</ul>}
      </>}
    </div> : null}
  </section>;
}
