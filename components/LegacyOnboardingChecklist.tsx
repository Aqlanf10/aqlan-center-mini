"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LegacyOnboarding } from "@/lib/legacy-onboarding";
import { useSession } from "./SessionProvider";

const CLASS_TEXT: Record<string, string> = {
  LEGACY_INCLUDED: "الشدّة اليوم مشمولة بالعلاج السابق — بلا فاتورة جديدة.",
  INCLUDED: "الشدّة اليوم مشمولة باتفاق الأقساط — بلا فاتورة مستقلة.",
  OUTSIDE_CONTRACT: "الشدّة اليوم تحتاج قرار فوترة (خارج العقد أو تُفوتر كل جلسة).",
  NEW_BILLABLE: "مستحق جديد.",
  NO_CHARGE: "بلا رسوم.",
};

export const LEGACY_ONBOARDING_READ_TIMEOUT_MS = 15_000;

type Props = {
  patientId: number;
  caseId: number;
  planId: number | null;
  refreshRevision: number;
};
type ReadState = { phase: "ready"; data: LegacyOnboarding }
  | { phase: "loading" | "error" | "denied" };

/** The endpoint selects a current case: never label another displayed case with
 * that result, and never derive a billing decision from the sibling plans read.
 */
function readOnboarding(payload: unknown, caseId: number): LegacyOnboarding {
  const value = payload && typeof payload === "object"
    ? (payload as { onboarding?: unknown }).onboarding : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing case context");
  const row = value as Record<string, unknown>;
  if (row.caseId !== caseId || typeof row.legacy !== "boolean" || typeof row.complete !== "boolean"
    || typeof row.adjustmentClass !== "string" || !Object.hasOwn(CLASS_TEXT, row.adjustmentClass)
    || (row.warning !== null && typeof row.warning !== "string") || !Array.isArray(row.steps)) {
    throw new Error("Invalid case context");
  }
  const keys = new Set<string>();
  const steps = row.steps.map((entry): LegacyOnboarding["steps"][number] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid checklist step");
    const step = entry as Record<string, unknown>;
    if (typeof step.key !== "string" || !["baseline", "financial_mode", "opening_balance", "arrangement", "plan"].includes(step.key)
      || keys.has(step.key) || typeof step.label !== "string" || typeof step.done !== "boolean"
      || typeof step.optional !== "boolean" || (step.hint !== null && typeof step.hint !== "string")) {
      throw new Error("Invalid checklist step");
    }
    keys.add(step.key);
    return { key: step.key as LegacyOnboarding["steps"][number]["key"], label: step.label,
      done: step.done, optional: step.optional, hint: step.hint as string | null };
  });
  return { legacy: row.legacy, complete: row.complete, steps,
    adjustmentClass: row.adjustmentClass as LegacyOnboarding["adjustmentClass"], warning: row.warning as string | null };
}

/** Read-only canonical classification, scoped to the case and confirmed changes. */
export function LegacyOnboardingChecklist(props: Props) {
  const session = useSession();
  if (!session) return null;
  const scope = JSON.stringify([props.patientId, props.caseId, props.planId, props.refreshRevision,
    session.username, session.role, session.permissions ?? null]);
  return <ScopedLegacyOnboardingChecklist key={scope} {...props} />;
}

function ScopedLegacyOnboardingChecklist({ patientId, caseId }: Props) {
  const [read, setRead] = useState<ReadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let expired = false;
    const controller = new AbortController();
    const current = () => !cancelled && !expired && mounted.current;
    const timeout = setTimeout(() => {
      expired = true;
      controller.abort();
      if (!cancelled && mounted.current) setRead({ phase: "error" });
    }, LEGACY_ONBOARDING_READ_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/legacy-onboarding`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) { setRead({ phase: "denied" }); return; }
        if (!response.ok) throw new Error("Checklist unavailable");
        const payload: unknown = await response.json();
        if (!current()) return;
        setRead({ phase: "ready", data: readOnboarding(payload, caseId) });
      } catch {
        if (current()) setRead({ phase: "error" });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [patientId, caseId, attempt]);

  if (read.phase !== "ready") return (
    <section className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px]"
      aria-label="تهيئة الحالة السابقة">
      <p role="status" className="font-bold text-slate-600">
        {read.phase === "loading" ? "جارٍ التحقق من تهيئة الحالة السابقة…"
          : read.phase === "denied" ? "تعذّر عرض تهيئة الحالة السابقة بصلاحية الجلسة الحالية؛ لا يمكن تأكيد تغطية الشدّة هنا."
            : "تعذّر تحديث تهيئة الحالة السابقة؛ لا يمكن تأكيد تغطية الشدّة من هذه القراءة."}
      </p>
      {read.phase === "error" ? (
        <button type="button" onClick={() => {
          if (!mounted.current) return;
          setRead({ phase: "loading" }); setAttempt((value) => value + 1);
        }} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-1 font-bold text-navy-800">
          أعد تحميل تهيئة الحالة السابقة
        </button>
      ) : null}
    </section>
  );
  const { data } = read;
  if (!data.legacy) return null;
  return (
    <section className={`mt-2 rounded-xl border px-3 py-2 text-[11px] ${data.complete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}
      aria-label="تهيئة الحالة السابقة">
      <p className="mb-1 font-extrabold text-navy-900">
        {data.complete ? "✓ تهيئة الحالة السابقة مكتملة" : "تهيئة الحالة السابقة — خطوات ناقصة"}
      </p>
      <ul className="space-y-0.5">
        {data.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-1.5">
            <span aria-hidden>{step.done ? "✅" : step.optional ? "◻️" : "⚠️"}</span>
            <span>
              <span className="font-bold text-slate-800">{step.label}</span>
              {step.optional && !step.done ? <span className="text-slate-500"> (اختياري)</span> : null}
              {!step.done && step.hint ? <span className="block text-slate-600">{step.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 font-bold text-slate-700">{CLASS_TEXT[data.adjustmentClass] ?? ""}</p>
      {data.warning ? <p className="mt-1 font-bold text-amber-800">{data.warning}</p> : null}
    </section>
  );
}
