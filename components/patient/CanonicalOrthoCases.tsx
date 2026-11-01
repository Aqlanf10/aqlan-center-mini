"use client";

import { makeCanonicalStrategyOwner, type CanonicalStrategyOwner } from "@/lib/canonical-ortho-strategy-owner";
import { makeAssessmentOwnerV2, type AssessmentOwnerV2 } from "@/lib/ortho-assessment-owner-v2";
import { CanonicalOrthoDetail } from "./CanonicalOrthoDetail";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, PHASE_LABEL, usesArchwires, type OrthoCaseSummaryFeed } from "@/lib/ortho";

/** Clinical summary with independently authorized native lifecycle actions.
 * Opening this section never mounts legacy editors or requests
 * their plan, image, assessment or financial endpoints. */
export function CanonicalOrthoCases({ patientId, ownerKey, canEdit = false, canReadCoverage = false }: { patientId: string; ownerKey: string; canEdit?: boolean; canReadCoverage?: boolean }) {
  const regionId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<OrthoCaseSummaryFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reuse the existing assessment owner across list/detail polling unmounts.
  // Clinical text stays only in this exact patient/session component lifetime.
  const assessments = useRef({ active: false, denied: false, allowed: new Set<number>(), owners: new Map<number, AssessmentOwnerV2>(), strategies: new Map<number, CanonicalStrategyOwner>() });
  useLayoutEffect(() => {
    const registry = assessments.current; registry.active = true;
    return () => { registry.active = false; for (const owner of [...registry.owners.values(), ...registry.strategies.values()]) owner.retire(); registry.owners.clear(); registry.strategies.clear(); };
  }, [assessments]);
  const assessmentOwnerFor = useCallback((id: number) => {
    const existing = assessments.current.owners.get(id); if (existing) return existing;
    const owner = makeAssessmentOwnerV2({ patientId: Number(patientId), orthoCaseId: id,
      authorized: () => assessments.current.active && !assessments.current.denied && canEdit && assessments.current.allowed.has(id),
      deny: () => {
        assessments.current.denied = true; assessments.current.allowed.clear();
        for (const saved of [...assessments.current.owners.values(), ...assessments.current.strategies.values()]) saved.retire();
        setFeed(null); setError("انتهت صلاحية التوثيق. أعد التحقق من الجلسة قبل فتح أي مسودة.");
      },
    });
    assessments.current.owners.set(id, owner); return owner;
  }, [assessments, canEdit, patientId]);
  const strategyOwnerFor = useCallback((id: number) => {
    const existing = assessments.current.strategies.get(id); if (existing) return existing;
    const owner = makeCanonicalStrategyOwner({
      authorized: () => assessments.current.active && !assessments.current.denied && canEdit && assessments.current.allowed.has(id),
      deny: () => {
        assessments.current.denied = true; assessments.current.allowed.clear();
        for (const saved of [...assessments.current.owners.values(), ...assessments.current.strategies.values()]) saved.retire();
        setFeed(null); setError("انتهت صلاحية التوثيق. أعد التحقق من الجلسة قبل فتح أي مسودة.");
      },
    });
    assessments.current.strategies.set(id, owner); return owner;
  }, [assessments, canEdit]);
  const canLeaveAssessments = useCallback(() => {
    if ([...assessments.current.owners.values(), ...assessments.current.strategies.values()].some(owner => !owner.canLeave(() => true))) {
      setNotice("هناك طلب توثيق جارٍ أو نتيجته غير مؤكدة. افتح التوثيق وتحقق من الطلب نفسه قبل المغادرة."); return false;
    }
    return ![...assessments.current.owners.values(), ...assessments.current.strategies.values()].some(owner => owner.needsUnloadWarning())
      || window.confirm("هناك توثيق غير محفوظ. هل تريد تجاهل المسودة ومغادرة القسم؟");
  }, [assessments]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if ([...assessments.current.owners.values(), ...assessments.current.strategies.values()].some(owner => owner.needsUnloadWarning())) { event.preventDefault(); event.returnValue = ""; }
    };
    const navigate = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.getAttribute("target") === "_blank") return;
      const destination = new URL(anchor.getAttribute("href")!, window.location.href);
      if (anchor.hasAttribute("download") || destination.origin !== window.location.origin
        || destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!canLeaveAssessments()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [assessments, canLeaveAssessments]);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); assessments.current.allowed.clear(); for (const owner of [...assessments.current.owners.values(), ...assessments.current.strategies.values()]) owner.invalidateRead(); setFeed(null); setError(null); };
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
        if (!response.ok) {
          if ([401, 403].includes(response.status)) { assessments.current.denied = true; for (const owner of [...assessments.current.owners.values(), ...assessments.current.strategies.values()]) owner.retire(); }
          throw new Error(payload?.message ?? "تعذّر تحميل حالات التقويم.");
        }
        if (payload?.projection !== "case-summary" || !Array.isArray(payload.cases)
          || payload.cases.some((row: { patientId?: unknown }) => row.patientId !== Number(patientId))) {
          throw new Error("تعذّر التحقق من قائمة الحالات. أعد تحميلها.");
        }
        assessments.current.allowed = new Set<number>(payload.cases.map((row: { id: number }) => row.id));
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
  }, [open, patientId, refresh, assessments]);

  return <section aria-label="حالات التقويم" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-navy-900">حالات التقويم</h2>
      <button type="button" aria-expanded={open} aria-controls={regionId}
        onClick={() => { if (open && !canLeaveAssessments()) return; if (open) { for (const owner of [...assessments.current.owners.values(), ...assessments.current.strategies.values()]) owner.retire(); assessments.current.owners.clear(); assessments.current.strategies.clear(); } setFeed(null); setError(null); setOpen(value => !value); }}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق الحالات" : "عرض حالات التقويم"}</button>
    </div>
    {open ? <div id={regionId} className="mt-3 space-y-3" data-testid="canonical-ortho-cases">
      {notice ? <p role="status">{notice}</p> : null}
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
            <CanonicalOrthoDetail patientId={patientId} caseId={row.id} ownerKey={ownerKey} canEdit={canEdit} canReadCoverage={canReadCoverage} assessmentOwnerFor={canEdit ? assessmentOwnerFor : undefined} strategyOwnerFor={canEdit ? strategyOwnerFor : undefined} onChanged={() => { setNotice("حُفظ تحديث حالة التقويم وسُجّل أثره."); setFeed(null); setRefresh(value => value + 1); }} />
          </li>)}</ul>}
      {feed?.hasMore ? <p role="status" className="text-sm text-amber-800">تظهر أحدث 300 حالة فقط؛ هذه ليست القائمة الكاملة.</p> : null}
    </div> : null}
  </section>;
}
