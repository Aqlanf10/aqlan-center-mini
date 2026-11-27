"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { friendlyDateLong } from "@/lib/reminders";
import { isAdmin } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";

import { isClinicalId } from "@/lib/patient-navigation";

export const canShowPrescriptionHistory = (role: string | null | undefined) => isAdmin(role) || role === "doctor";

type SavedRx = { id: number; createdAt: string; status: "active" | "void"; itemCount: number };
type History = { kind: "loading" | "unavailable" | "denied" } | { kind: "loaded"; rows: SavedRx[] };
const loading: History = { kind: "loading" };

function readHistory(payload: unknown, patientId: number): SavedRx[] | null {
  if (!payload || typeof payload !== "object" || !("prescriptions" in payload)
    || !Array.isArray(payload.prescriptions)) return null;

  const rows: SavedRx[] = [];
  const ids = new Set<number>();
  for (const value of payload.prescriptions as unknown[]) {
    if (!value || typeof value !== "object" || !("id" in value) || !isClinicalId(value.id) || ids.has(value.id)
      || !("patientId" in value) || value.patientId !== patientId
      || !("createdAt" in value) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || !("status" in value) || (value.status !== "active" && value.status !== "void")
      || !("items" in value) || !Array.isArray(value.items)) return null;
    ids.add(value.id);
    rows.push({ id: value.id, createdAt: value.createdAt, status: value.status, itemCount: value.items.length });
  }
  return rows;
}

/** One read, shared by Summary and the prescriptions tab. Data is retired
 * immediately on leaving both views, a chart change or a principal change. */
export function usePatientPrescriptionHistory(patientId: number | null, principalKey: string) {
  const [version, setVersion] = useState(0);
  const scope = useMemo(() => isClinicalId(patientId) ? { patientId, principalKey, version } : null,
    [patientId, principalKey, version]);
  const [accepted, setAccepted] = useState<{ scope: typeof scope; history: History }>();
  useEffect(() => {
    if (!scope) return;
    const { patientId } = scope;
    const controller = new AbortController();
    const update = (history: History) => {
      if (!controller.signal.aborted) setAccepted({ scope, history });
    };
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/prescriptions`, {
          method: "GET", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) {
          update({ kind: [401, 403, 404].includes(response.status) ? "denied" : "unavailable" });
          return;
        }
        const rows = readHistory(await response.json(), patientId);
        update(rows ? { kind: "loaded", rows } : { kind: "unavailable" });
      } catch {
        update({ kind: "unavailable" });
      }
    })();
    return () => controller.abort();
  }, [scope]);
  return {
    history: scope && accepted?.scope === scope ? accepted.history : loading,
    refresh: () => setVersion((value) => value + 1),
  };
}

export function PatientPrescriptionHistory({ patientId, history, refresh, openHistory }: {
  patientId: number;
  history: History;
  refresh: () => void;
  openHistory?: () => void;
}) {
  const headingId = useId();
  const compact = Boolean(openHistory);
  const rows = history.kind === "loaded" ? (compact ? history.rows.slice(0, 2) : history.rows) : null;
  return (
    <section aria-labelledby={headingId} dir="rtl" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-sm font-extrabold text-navy-900">الوصفات الطبية</h2>
          {!compact ? <p className="mt-1 text-xs text-slate-600">آخر 50 وصفة محفوظة في هذا الملف. فتح نسخة محفوظة لا يُصدر وصفة جديدة.</p> : null}
        </div>
        {openHistory ? (
          <button type="button" onClick={openHistory} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50">
            عرض الوصفات المحفوظة
          </button>
        ) : history.kind === "loaded" ? (
          <button type="button" onClick={refresh} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50">
            تحديث القائمة
          </button>
        ) : null}
      </div>
      {history.kind === "loading" ? <p role="status" className="text-xs text-slate-600">جارٍ تحميل الروشتات المحفوظة…</p> : null}
      {history.kind === "denied" ? <p role="alert" className="text-xs text-rose-800">تعذّر الوصول إلى الروشتات المحفوظة.</p> : null}
      {history.kind === "unavailable" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-xs text-rose-800">تعذّر تحميل الروشتات المحفوظة.</p>
          <button type="button"
            onClick={refresh}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50">
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {rows && rows.length === 0 ? <p role="status" className="text-xs text-slate-600">لا توجد روشتات محفوظة لهذا المريض.</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="grid gap-2">
          {rows.map((row) => {
            const voided = row.status === "void";
            const label = voided ? "عرض الوصفة المبطلة" : "فتح نسخة للطباعة";
            return (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-700">
                  <span className="font-bold text-navy-900">وصفة <bdi>#{row.id}</bdi></span>
                  <time dateTime={row.createdAt}>{friendlyDateLong(clinicDateString(new Date(row.createdAt), CLINIC_ZONE_FALLBACK))}</time>
                  <span>عدد الأدوية: {row.itemCount}</span>
                  <span className={voided ? "rounded-full bg-rose-50 px-2 py-1 font-bold text-rose-800"
                    : "rounded-full bg-emerald-50 px-2 py-1 font-bold text-emerald-800"}>
                    {voided ? "مُبطلة، لا تُصرف" : "سارية"}
                  </span>
                </div>
                {!compact ? (
                  <a href={`/print/prescription/${patientId}?rx=${row.id}`} target="_blank" rel="noopener noreferrer"
                    aria-label={`${label} رقم ${row.id} (علامة تبويب جديدة)`}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50">
                    {label}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
