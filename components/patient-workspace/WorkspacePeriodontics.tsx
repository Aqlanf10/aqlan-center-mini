"use client";

import { PeriodonticsWorkspace } from "@/components/periodontics/PeriodonticsWorkspace";
import { periodontalVisitId } from "@/lib/patient-periodontal-context";
import { usePeriodontalContext } from "./usePeriodontalContext";
import type { WorkspaceSummary } from "./usePatientWorkspace";
import styles from "./workspace.module.css";

export function WorkspacePeriodontics({ patientId, patientName, authorityKey, editable, summary, structuredRefreshKey = 0,
  onRefresh, onPersisted, onDraftChange, onNavigationGuardChange }: {
  patientId: number; patientName: string; authorityKey: string; editable: boolean; summary: WorkspaceSummary | null;
  structuredRefreshKey?: number | string; onRefresh: () => void; onPersisted?: () => void;
  onDraftChange?: (pending: boolean) => void; onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}) {
  const context = usePeriodontalContext({ patientId, authorityKey, visitId: periodontalVisitId(summary), refreshKey: structuredRefreshKey });
  if (context.denied) return <div role="alert" className={styles.notice}>لم يعد سياق فحص اللثة متاحًا ضمن الوصول الحالي. أُخفيت بيانات المساحة السابقة.<button type="button" className={styles.button} onClick={() => { onRefresh(); void context.reload(); }}>إعادة التحقق من الملف</button></div>;
  return <PeriodonticsWorkspace patientId={patientId} patientName={patientName} authorityKey={authorityKey} editable={editable}
    currentVisit={context.value?.currentVisit ?? null} contextStatus={context.status} contextError={context.error}
    doctors={context.value?.doctors ?? []} cases={context.value?.cases ?? []}
    onRetryContext={() => { if (periodontalVisitId(summary) === undefined) onRefresh(); else void context.reload(); }}
    onDraftChange={onDraftChange} onNavigationGuardChange={onNavigationGuardChange} onPersisted={onPersisted} />;
}
