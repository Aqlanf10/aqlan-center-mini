"use client";

import { clinicalContextHref, type ClinicalNavigationContext } from "@/lib/patient-navigation";

import { useEffect, useState } from "react";
import {
  APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, PHASE_LABEL,
  type Appliance, type Arches, type CaseStatus, type OrthoPhase,
} from "@/lib/ortho";
import { useSession } from "./SessionProvider";

export const LEGACY_ORTHO_READ_TIMEOUT_MS = 15_000;

interface LegacyCase {
  id: number;
  appliance: Appliance;
  arches: Arches;
  status: CaseStatus;
  phase: OrthoPhase;
  startDate: string;
}

type ReadState =
  | { patientId: number; phase: "ready"; cases: LegacyCase[] }
  | { patientId: number; phase: "error" | "denied" };

/** Clinical references only: no archive amounts, agreements, or writes. */
type LegacyContextProps = { patientId: number; onOpenClinicalContext?: (context: ClinicalNavigationContext) => unknown };
export function LegacyOrthoPlanContext({ patientId, onOpenClinicalContext }: LegacyContextProps) {
  const session = useSession();
  if (!session) return null;
  // A new patient or authority scope gets a new component instance. Even
  // A→B→A must load fresh instead of reviving the first A's ready state.
  const scope = JSON.stringify([patientId, session.username, session.role, session.permissions ?? null]);
  return <ScopedLegacyOrthoPlanContext key={scope} patientId={patientId} onOpenClinicalContext={onOpenClinicalContext} />;
}

function ScopedLegacyOrthoPlanContext({ patientId, onOpenClinicalContext }: LegacyContextProps) {
  const [result, setResult] = useState<ReadState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let expired = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      expired = true;
      controller.abort();
      if (!cancelled) setResult({ patientId, phase: "error" });
    }, LEGACY_ORTHO_READ_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`/api/ortho?patientId=${patientId}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (cancelled || expired) return;
        if (response.status === 401 || response.status === 403) {
          if (!cancelled) setResult({ patientId, phase: "denied" });
          return;
        }
        if (!response.ok) throw new Error("Legacy context unavailable");
        const payload = await response.json() as { cases?: Record<string, unknown>[] };
        if (cancelled || expired) return;
        if (!Array.isArray(payload.cases)
          || payload.cases.some((row) => !row || row.patientId !== patientId)) {
          throw new Error("Invalid patient context");
        }
        const cases = payload.cases.filter((row) => row.baselineKind === "legacy").map((row): LegacyCase => {
          if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0
            || typeof row.appliance !== "string" || !Object.hasOwn(APPLIANCE_LABEL, row.appliance)
            || typeof row.arches !== "string" || !Object.hasOwn(ARCHES_LABEL, row.arches)
            || typeof row.status !== "string" || !Object.hasOwn(CASE_STATUS_LABEL, row.status)
            || typeof row.phase !== "string" || !Object.hasOwn(PHASE_LABEL, row.phase)
            || typeof row.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.startDate)) {
            throw new Error("Invalid legacy case");
          }
          return {
            id: Number(row.id), appliance: row.appliance as Appliance, arches: row.arches as Arches,
            status: row.status as CaseStatus, phase: row.phase as OrthoPhase, startDate: row.startDate,
          };
        });
        if (!cancelled && !expired) setResult({ patientId, phase: "ready", cases });
      } catch {
        if (!cancelled && !expired) setResult({ patientId, phase: "error" });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [patientId, attempt]);

  // A changed patient must never display the preceding patient's case while loading.
  const current = result?.patientId === patientId ? result : null;
  if (current?.phase === "ready" && current.cases.length === 0) return null;

  return (
    <section aria-label="التقويم السابق ضمن خطة المريض" className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
      <h3 className="text-sm font-extrabold text-navy-900">التقويم السابق ضمن خطة المريض</h3>
      {!current ? (
        <p role="status" className="mt-1 text-xs text-slate-600">جارٍ تحميل حالات التقويم السابقة…</p>
      ) : current.phase !== "ready" ? (
        <div className="mt-2 space-y-2 text-xs text-slate-600">
          <p role="status">{current.phase === "denied"
            ? "تعذّر عرض حالات التقويم السابقة بصلاحية الجلسة الحالية."
            : "تعذّر تحميل حالات التقويم السابقة؛ هذا لا يعني عدم وجود حالة."}</p>
          {current.phase === "error" ? (
            <button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-bold text-navy-900">
              أعد تحميل حالات التقويم
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            هذه حالات تقويم بدأ علاجها قبل البرنامج، وتُتابع من ملف التقويم نفسه.
            ظهورها هنا لا ينشئ اتفاقًا ماليًا أو يضيف مبلغًا على المريض.
          </p>
          <ul className="mt-2 space-y-2">
            {current.cases.map((row) => (
              <li key={row.id} className="rounded-xl border border-amber-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-extrabold text-navy-900">
                    حالة #{row.id} · {APPLIANCE_LABEL[row.appliance]} · {ARCHES_LABEL[row.arches]}
                  </p>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-700">{CASE_STATUS_LABEL[row.status]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {PHASE_LABEL[row.phase]} · بدء العلاج: <bdi>{row.startDate}</bdi>
                </p>
                <a href={clinicalContextHref(patientId, { orthoCaseId: row.id, pillar: "wires" }, "ortho")}
                  onClick={(event) => { if (onOpenClinicalContext) { event.preventDefault(); onOpenClinicalContext({ patientId, orthoCaseId: row.id, pillar: "wires" }); } }}
                  className="mt-2 inline-block rounded-lg border border-navy-200 px-3 py-1.5 text-xs font-bold text-navy-900">
                  متابعة الحالة من ملف التقويم
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
