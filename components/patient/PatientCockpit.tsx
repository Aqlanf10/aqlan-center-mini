"use client";

import { useEffect, useState } from "react";
import { minutesSince } from "@/lib/flow";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { formatMoney } from "@/lib/money";
import { suggestSpecialtyTab, type SpecialtyTab } from "@/lib/chair-readiness";
import { useChairCount } from "@/components/SettingsProvider";
import { usePatientCockpitReadiness } from "./usePatientCockpitReadiness";
import type { WorkflowSummary } from "./SummaryTab";

const STATUS_TEXT: Record<string, string> = {
  waiting: "في الانتظار",
  called: "نُودي",
  in_chair: "على الكرسي",
  done: "انتهى الجلوس",
};

const hhmm = (iso: string | null) => (iso
  ? new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", timeZone: CLINIC_ZONE_FALLBACK }).format(new Date(iso))
  : "");

/**
 * (CHAIR-1 Slice 4) قمرة ملف المريض — شريطٌ ثابت أعلى الملف، **تركيبٌ لا محرّك**.
 *
 * يعرض: الاسم والتنبيهات، والرصيد بكل عملة (لمن يُسمح له فقط — الخادم يقرّر)، وحالة زيارة اليوم
 * وكرسيّها ووقتها، ومراحل الرحلة وصول → جاهز → على الكرسي → توقيع → دفع.
 *
 * «إدخال إلى الكرسي» يعيد استعمال الزيارة القائمة (ومنع الزيارة المكرّرة LIVE-4 في `POST /api/visits`)
 * ثم حركة الإجلاس نفسها عبر بوابة الجاهزية — لا زيارة جديدة ولا مسار جديد. ومقترح التخصص زرٌّ
 * يُضغط، لا انتقالٌ تلقائي.
 */
export function PatientCockpit({
  patientId, patientName, patientPhone, fallbackAlert, summary, onOpenTab, onChanged,
}: {
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  /** التنبيه النصي في الملف — يُعرض إن لم يرجع الخادم تفاصيل الجاهزية. */
  fallbackAlert: string | null;
  summary: WorkflowSummary | null;
  onOpenTab: (tab: SpecialtyTab) => void;
  onChanged: () => void;
}) {
  const chairCount = useChairCount();
  const { visit, alerts, readiness, chairsState, coherent, canOperate, active, freeChairs, selectedChair,
    busy, message, canEnterChair, setChair, reload, clear, enterChair } = usePatientCockpitReadiness({
    patientId, patientName, patientPhone, fallbackAlert, summary, chairCount, onChanged,
  });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const suggestion = suggestSpecialtyTab({
    orthoActive: summary?.counts.orthoCase === true,
    plannedTodayTitle: summary?.openVisit?.plannedTitle ?? null,
    planSpecialty: summary?.activePlans[0]?.specialty ?? null,
    hasOpenVisit: active,
  });
  const statusLine = (() => {
    if (readiness === "loading") return "حالة الزيارة قيد التحقق";
    if (readiness === "unavailable") return "حالة الزيارة غير متاحة الآن";
    if (!visit) return "لا زيارة اليوم في القراءة الحالية";
    if (visit.signedAt) return "وُقّعت الزيارة";
    const base = STATUS_TEXT[visit.status] ?? visit.status;
    if (visit.status === "in_chair") {
      return `${base}${visit.chair ? ` ${visit.chair}` : ""} منذ ${hhmm(visit.seatedAt)} (${minutesSince(visit.seatedAt, now)} د)`;
    }
    if (visit.status === "called") return `${base} — كرسي ${visit.chair ?? "؟"}`;
    if (visit.status === "waiting") return `${base} منذ ${hhmm(visit.arrivedAt)}`;
    return `${base} — بانتظار التوقيع`;
  })();

  return (
    <div className="sticky top-0 z-30 -mx-4 mb-3 border-b border-slate-200 bg-white/95 px-4 py-2 shadow-xs backdrop-blur" aria-label="قمرة المريض">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="truncate text-sm font-black text-navy-900">{patientName}</span>
        {alerts.length > 0 ? (
          <span className="rounded-lg bg-red-600 px-2 py-0.5 text-[11px] font-black text-white" title={alerts.join(" • ")}>
            ⚠️ {alerts.length > 2 ? `${alerts.slice(0, 2).join(" • ")} …` : alerts.join(" • ")}
          </span>
        ) : null}
        {(visit?.balances ?? []).map((line) => (
          <span key={line.currency}
            className={`rounded-lg px-2 py-0.5 text-[11px] font-black ${line.warn ? "bg-amber-200 text-amber-950" : "bg-amber-50 text-amber-900"}`}>
            عليه {formatMoney(line.dueMinor, line.currency)}
          </span>
        ))}
        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">🪑 {statusLine}</span>
        {visit?.cleared ? (
          <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">جاهز ✓</span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {visit?.stepper ? (
          <ol className="flex flex-wrap items-center gap-1" aria-label="مراحل الزيارة">
            {visit.stepper.steps.map((step) => (
              <li key={step.key}
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  step.done ? "bg-emerald-600 text-white"
                    : visit.stepper?.current === step.key ? "border border-brand-orange bg-orange-50 text-brand-orange"
                      : "bg-slate-100 text-slate-400"
                }`}>
                {step.done ? "✓ " : ""}{step.label}
              </li>
            ))}
          </ol>
        ) : null}

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {canOperate && active && !visit?.cleared && visit?.checklist !== null ? (
            <button type="button" onClick={() => void clear()} disabled={busy}
              title={(visit?.checklist ?? []).map((item) => item.label).join("\n")}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800 disabled:opacity-40">
              أقِرّ الجاهزية{visit?.attention ? ` (${visit.attention})` : ""}
            </button>
          ) : null}
          {canEnterChair ? (
            <span className="flex items-center gap-1">
              {freeChairs.length > 1 && visit?.status !== "called" ? (
                <select aria-label="الكرسي" disabled={busy} value={selectedChair ?? ""} onChange={(event) => setChair(Number(event.target.value))}
                  className="rounded-lg border border-slate-200 bg-white px-1 py-1 text-[11px] font-bold">
                  {freeChairs.map((n) => <option key={n} value={n}>كرسي {n}</option>)}
                </select>
              ) : null}
              <button type="button" onClick={() => void enterChair()} disabled={busy || !selectedChair}
                className="rounded-lg bg-brand-orange px-3 py-1 text-[11px] font-extrabold text-white disabled:opacity-40">
                إدخال إلى الكرسي{selectedChair ? ` ${selectedChair}` : ""}
              </button>
            </span>
          ) : null}
          {suggestion ? (
            <button type="button" onClick={() => onOpenTab(suggestion.tab)} title={suggestion.reason}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-bold text-indigo-900">
              مقترح: {suggestion.label} ←
            </button>
          ) : null}
        </div>
      </div>

      {readiness !== "ready" || chairsState !== "ready" || !coherent ? (
        <p role="status" data-testid="patient-cockpit-read-state" className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
          {readiness === "unavailable" ? "تعذّر التحقق من الزيارة؛ إدخال الكرسي متوقف حتى التحديث."
            : readiness === "loading" ? "جارٍ التحقق من الزيارة والكراسي؛ لا تُفترض جاهزية أو إتاحة."
              : chairsState === "loading" ? "جارٍ التحقق من إتاحة الكراسي."
                : chairsState === "unavailable" ? "إتاحة الكراسي غير معروفة؛ أعد التحقق قبل الإدخال."
                  : "قراءات الزيارة والكراسي غير متطابقة؛ أعد التحقق قبل الإدخال."}
          <button type="button" disabled={busy} onClick={() => void reload()} className="rounded border border-slate-200 px-2 py-1 font-bold">إعادة التحقق</button>
        </p>
      ) : null}

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"}
          className={`mt-1 text-[11px] font-bold ${message.tone === "error" ? "text-red-700" : message.tone === "warn" ? "text-amber-800" : "text-emerald-700"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
