"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { minutesSince, type Visit } from "@/lib/flow";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { formatMoney } from "@/lib/money";
import { patientContextAlerts, suggestSpecialtyTab, type ChairStep, type ChairStepKey, type SpecialtyTab } from "@/lib/chair-readiness";
import { useChairCount } from "@/components/SettingsProvider";
import { sendGatedMove, type VisitReadiness } from "@/components/today/useChairReadiness";
import type { WorkflowSummary } from "./SummaryTab";

interface CockpitVisit extends VisitReadiness {
  stepper?: { steps: ChairStep[]; current: ChairStepKey | null };
  /** Latest locally confirmed save when this readiness request started. */
  confirmedAlertRevision: number;
}

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
  compact = false, identity, primaryAction, secondaryActions, safety, confirmedAlert,
}: {
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  /** Current editable patient alert, authoritative even before the next readiness poll. */
  fallbackAlert: string | null;
  confirmedAlert?: { revision: number; value: string | null };
  summary: WorkflowSummary | null;
  onOpenTab: (tab: SpecialtyTab) => void;
  onChanged: () => void;
  /** Presentation slots reuse the patient page's existing identity and actions. */
  compact?: boolean;
  identity?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  safety?: ReactNode;
}) {
  const chairCount = useChairCount();
  const [visit, setVisit] = useState<CockpitVisit | null>(null);
  const [todayVisits, setTodayVisits] = useState<Visit[]>([]);
  const [chair, setChair] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "warn" | "error" | "ok"; text: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const requestSequence = useRef(0);
  const confirmedAlertRevision = confirmedAlert?.revision ?? 0;

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const [readiness, visits] = await Promise.all([
        fetch(`/api/visits/readiness?patientId=${patientId}`, { cache: "no-store" }),
        fetch("/api/visits", { cache: "no-store" }),
      ]);
      if (readiness.ok) {
        const payload = await readiness.json() as { visit?: CockpitVisit | null };
        if (sequence !== requestSequence.current) return;
        setVisit(payload.visit ? { ...payload.visit, confirmedAlertRevision } : null);
      }
      if (visits.ok) {
        const payload = await visits.json();
        if (sequence !== requestSequence.current) return;
        if (Array.isArray(payload)) setTodayVisits(payload as Visit[]);
      }
    } catch { /* القمرة مساعدة — تعذّرها لا يعطّل الملف */ }
  }, [patientId, confirmedAlertRevision]);

  useEffect(() => {
    const first = setTimeout(() => { void reload(); }, 0);
    const poll = setInterval(() => { void reload(); setNow(new Date()); }, 30_000);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [reload, fallbackAlert, summary?.openVisit?.id, summary?.openVisit?.status]);

  /* الكراسي المتاحة لهذا المريض: كرسيّ ندائه إن نُودي، وإلا الفارغة اليوم. */
  const freeChairs = useMemo(() => {
    if (visit?.status === "called" && visit.chair) return [visit.chair];
    const others = todayVisits.filter((row) => row.id !== visit?.visitId);
    const free: number[] = [];
    for (let n = 1; n <= chairCount; n += 1) {
      const taken = others.some((row) => row.chair === n && (row.status === "in_chair" || row.status === "called"));
      if (!taken) free.push(n);
    }
    return free;
  }, [todayVisits, visit, chairCount]);
  const selectedChair = chair !== null && freeChairs.includes(chair) ? chair : freeChairs[0] ?? null;

  const active = visit !== null && visit.signedAt === null && visit.status !== "done";
  const canEnterChair = visit === null || (visit.signedAt === null
    && (visit.status === "waiting" || visit.status === "called"));
  const suggestion = suggestSpecialtyTab({
    orthoActive: summary?.counts.orthoCase === true,
    plannedTodayTitle: summary?.openVisit?.plannedTitle ?? null,
    planSpecialty: summary?.activePlans[0]?.specialty ?? null,
    hasOpenVisit: active,
  });
  const alerts = patientContextAlerts(fallbackAlert, visit, confirmedAlert);

  const clear = async () => {
    if (!visit || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visit.visitId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }),
      });
      const payload = await response.json().catch(() => null);
      setMessage(response.ok ? null : { tone: "error", text: payload?.message ?? "تعذّر إقرار الجاهزية." });
      await reload();
    } catch {
      setMessage({ tone: "error", text: "تعذّر الاتصال بالخادم." });
    } finally {
      setBusy(false);
    }
  };

  const enterChair = async () => {
    if (busy) return;
    if (!selectedChair) { setMessage({ tone: "error", text: "لا كرسي فارغ الآن — راجع لوحة اليوم." }); return; }
    setBusy(true);
    setMessage(null);
    try {
      /* الزيارة القائمة تُستعمل كما هي؛ وإلا يُسجَّل الوصول بالمسار نفسه، و409 (LIVE-4) يعيد القائمة. */
      let visitId = visit && visit.signedAt === null && visit.status !== "done" ? visit.visitId : null;
      if (visitId === null) {
        const created = await fetch("/api/visits", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId, patientName, patientPhone, note: "دخول مباشر من ملف المريض" }),
        });
        const payload = await created.json().catch(() => null);
        if (created.ok && typeof payload?.id === "number") visitId = payload.id;
        else if (created.status === 409 && typeof payload?.visitId === "number") visitId = payload.visitId;
        else { setMessage({ tone: "error", text: payload?.message ?? "تعذّر تسجيل الوصول." }); return; }
      }
      const response = await sendGatedMove(visitId as number, { action: "seat", chair: selectedChair });
      const payload = await response.json().catch(() => null);
      if (!response.ok) setMessage({ tone: "error", text: payload?.message ?? "تعذّر الإدخال إلى الكرسي." });
      else setMessage(typeof payload?.warning === "string" ? { tone: "warn", text: payload.warning } : { tone: "ok", text: `على الكرسي ${selectedChair}` });
      await reload();
      onChanged();
    } catch {
      setMessage({ tone: "error", text: "تعذّر الاتصال بالخادم." });
    } finally {
      setBusy(false);
    }
  };

  const statusLine = (() => {
    if (!visit) return "لا زيارة اليوم";
    if (visit.signedAt) return "وُقّعت الزيارة";
    const base = STATUS_TEXT[visit.status] ?? visit.status;
    if (visit.status === "in_chair") {
      return `${base}${visit.chair ? ` ${visit.chair}` : ""} منذ ${hhmm(visit.seatedAt)} (${minutesSince(visit.seatedAt, now)} د)`;
    }
    if (visit.status === "called") return `${base} — كرسي ${visit.chair ?? "؟"}`;
    if (visit.status === "waiting") return `${base} منذ ${hhmm(visit.arrivedAt)}`;
    return `${base} — بانتظار التوقيع`;
  })();

  const visitSteps = visit?.stepper ? (
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
        ) : null;

  return (
    <div className={compact
      ? "mb-2 rounded-xl border border-slate-200 bg-white px-3 py-2"
      : "-mx-3 sm:-mx-4 mb-3 border-b border-slate-200 bg-white/95 px-4 py-2 shadow-xs backdrop-blur"}
      aria-label="قمرة المريض" data-testid="patient-context-strip" data-compact={compact ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {compact && identity ? <div className="w-full min-w-0">{identity}</div>
          : <span className="truncate text-sm font-black text-navy-900">{patientName}</span>}
        {alerts.length > 0 ? (
          <span className="max-w-full break-words rounded-lg bg-red-600 px-2 py-0.5 text-[11px] font-black text-white" title={alerts.join(" • ")}>
            ⚠️ {compact ? alerts.join(" • ") : alerts.length > 2 ? `${alerts.slice(0, 2).join(" • ")} …` : alerts.join(" • ")}
          </span>
        ) : null}
        {(visit?.balances ?? []).map((line) => (
          <span key={line.currency}
            className={`rounded-lg px-2 py-0.5 text-[11px] font-black ${line.warn ? "bg-amber-200 text-amber-950" : "bg-amber-50 text-amber-900"}`}>
            عليه {formatMoney(line.dueMinor, line.currency)}
          </span>
        ))}
        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">🪑 {statusLine}</span>
        {compact ? safety : null}
        {visit?.cleared ? (
          <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">جاهز ✓</span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {!compact ? visitSteps : null}

        <div className={`${compact ? "w-full" : "ms-auto"} flex flex-wrap items-center gap-1.5`}>
          {compact ? primaryAction : null}
          {compact ? secondaryActions : null}
          {active && !visit?.cleared && visit?.checklist !== null ? (
            <button type="button" onClick={() => void clear()} disabled={busy}
              title={(visit?.checklist ?? []).map((item) => item.label).join("\n")}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800 disabled:opacity-40">
              أقِرّ الجاهزية{visit?.attention ? ` (${visit.attention})` : ""}
            </button>
          ) : null}
          {canEnterChair ? (
            <span className="flex items-center gap-1">
              {freeChairs.length > 1 && visit?.status !== "called" ? (
                <select aria-label="الكرسي" value={selectedChair ?? ""} onChange={(event) => setChair(Number(event.target.value))}
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
          {!compact && suggestion ? (
            <button type="button" onClick={() => onOpenTab(suggestion.tab)} title={suggestion.reason}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-bold text-indigo-900">
              مقترح: {suggestion.label} ←
            </button>
          ) : null}
        </div>
      </div>

      {compact && (visitSteps || suggestion) ? (
        <details className="mt-1 text-[11px]" data-testid="patient-visit-details">
          <summary className="cursor-pointer font-bold text-slate-600">مراحل الزيارة</summary>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {visitSteps}
            {suggestion ? <button type="button" onClick={() => onOpenTab(suggestion.tab)} title={suggestion.reason}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 font-bold text-indigo-900">
              مقترح: {suggestion.label}
            </button> : null}
          </div>
        </details>
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
