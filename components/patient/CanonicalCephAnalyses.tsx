"use client";

import { useEffect, useId, useState } from "react";

interface CephAnalysisSummaryRow {
  id: number;
  patientId: number;
  status: "draft" | "completed" | "discarded";
  phase: "pretreatment" | "during" | "posttreatment" | "followup";
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
}

const CEPH_PHASE_LABEL: Record<CephAnalysisSummaryRow["phase"], string> = {
  pretreatment: "قبل العلاج (T1)",
  during: "أثناء العلاج (T2)",
  posttreatment: "بعد العلاج (T3)",
  followup: "متابعة (T4)",
};

const CEPH_STATUS_LABEL: Record<CephAnalysisSummaryRow["status"], string> = {
  draft: "مسودة قيد الرسم",
  completed: "معتمد ومختوم",
  discarded: "مرفوض",
};

/**
 * ملخص تحليلات السيفالومتري في ملف المريض الموحّد (M2 slice 30).
 * لا يستدعي مسار المستندات (`/api/documents/[id]`) ولا يحمّل محرّرات قديمة.
 */
export function CanonicalCephAnalyses({ patientId }: { patientId: string }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [analyses, setAnalyses] = useState<CephAnalysisSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => {
      sequence++;
      controller?.abort();
      setAnalyses(null);
      setError(null);
    };
    const load = async () => {
      clear();
      if (document.visibilityState === "hidden") return;
      const request = sequence;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}/ceph`, {
          cache: "no-store",
          signal: current.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل تحليلات السيفالو.");
        if (
          !Array.isArray(payload?.analyses)
          || payload.analyses.some((row: { patientId?: unknown }) => row.patientId !== Number(patientId))
        ) {
          throw new Error("تعذّر التحقق من تحليلات السيفالو. أعد تحميلها.");
        }
        setAnalyses(payload.analyses as CephAnalysisSummaryRow[]);
      } catch (failure) {
        if (alive && request === sequence) {
          setError(
            failure instanceof Error && failure.name === "Error"
              ? failure.message
              : "تعذّر الاتصال بالخادم. أعد تحميل التحليلات.",
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    };
    const visible = () => {
      if (document.visibilityState === "hidden") clear();
      else void load();
    };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      sequence++;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, patientId, refresh]);

  return (
    <section aria-label="تحليلات السيفالومتري" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-navy-900">تحليلات السيفالومتري</h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setAnalyses(null);
            setError(null);
            setOpen(value => !value);
          }}
          className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800"
        >
          {open ? "إغلاق التحليلات" : "عرض تحليلات السيفالو"}
        </button>
      </div>
      {open ? (
        <div id={regionId} className="mt-3 space-y-3" data-testid="canonical-ceph-analyses">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-600">الدراسات المسجّلة وقياسات الاعتماد المختومة (ANB · FMA · WITS).</p>
            <button
              type="button"
              onClick={() => {
                setAnalyses(null);
                setError(null);
                setRefresh(value => value + 1);
              }}
              className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800"
            >
              تحديث التحليلات
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-700">{error}</p>
          ) : !analyses ? (
            <p role="status" className="text-sm text-slate-500">جارٍ تحميل التحليلات…</p>
          ) : analyses.length === 0 ? (
            <p className="text-sm text-slate-600">لا توجد تحليلات سيفالومتري مسجّلة لهذا المريض.</p>
          ) : (
            <ul className="space-y-3">
              {analyses.map(row => (
                <li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-3 text-sm [overflow-wrap:anywhere]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-bold text-navy-900">
                      دراسة #{row.id} — {CEPH_PHASE_LABEL[row.phase] ?? row.phase}
                    </h3>
                    <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold">
                      {CEPH_STATUS_LABEL[row.status] ?? row.status}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-slate-500">تاريخ الشععة</dt>
                      <dd dir="ltr">{row.xrayDate ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">الاعتماد</dt>
                      <dd>{row.completedBy ? `بيد ${row.completedBy}` : `مسودة (${row.createdBy})`}</dd>
                    </div>
                    {row.findings ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-slate-500">القياسات المختومة</dt>
                        <dd dir="ltr" className="font-semibold text-navy-900">
                          ANB: {row.findings.anb ?? "—"}° · FMA: {row.findings.fma ?? "—"}° · WITS: {row.findings.wits ?? "—"} mm
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
