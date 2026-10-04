"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";

export const ORTHO_PACKAGE_READ_TIMEOUT_MS = 15_000;

interface PlanOption {
  id: number;
  title: string;
  status: "active" | "completed" | "cancelled";
  installmentCount: number;
}
type ReadState = { phase: "ready"; plans: PlanOption[] } | { phase: "loading" | "error" | "denied" };
interface Props {
  caseId: number; patientId: number; planId: number | null; canLink: boolean; onChanged: () => void;
}

/** Keep only the fields needed for this reference; never retain payment amounts. */
function readPlans(payload: unknown, patientId: number): PlanOption[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { plans?: unknown }).plans)) {
    throw new Error("Invalid plan context");
  }
  const ids = new Set<number>();
  return ((payload as { plans: unknown[] }).plans).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid plan");
    const row = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || ids.has(Number(row.id))
      || row.patientId !== patientId || typeof row.title !== "string" || !row.title.trim()
      || typeof row.status !== "string" || !["active", "completed", "cancelled"].includes(row.status)
      || !Array.isArray(row.installments)
      || row.installments.some((one) => !one || typeof one !== "object" || Array.isArray(one)
        || !Number.isSafeInteger(one.id) || one.id <= 0)) {
      throw new Error("Invalid patient plan");
    }
    ids.add(Number(row.id));
    return { id: Number(row.id), title: row.title, status: row.status as PlanOption["status"], installmentCount: row.installments.length };
  });
}

/**
 * (P1-B) The case remains clinical; its existing installment agreement is the
 * financial source. An unavailable read must never claim that it is unfunded.
 */
export function OrthoPackageLink(props: Props) {
  const session = useSession();
  if (!session) return null;
  const scope = JSON.stringify([
    props.patientId, props.caseId, props.planId, props.canLink,
    session.username, session.role, session.permissions ?? null,
  ]);
  return <ScopedOrthoPackageLink key={scope} {...props} />;
}

function ScopedOrthoPackageLink({ caseId, patientId, planId, canLink, onChanged }: Props) {
  const [read, setRead] = useState<ReadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const currentRead = useRef<ReadState>({ phase: "loading" });

  // Retire old handlers at commit, before another patient's effects can run.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let expired = false;
    const controller = new AbortController();
    const publish = (next: ReadState) => {
      if (cancelled || !mounted.current) return;
      currentRead.current = next;
      setRead(next);
    };
    const timeout = setTimeout(() => {
      expired = true;
      controller.abort();
      publish({ phase: "error" });
    }, ORTHO_PACKAGE_READ_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`/api/plans?patientId=${patientId}`, { cache: "no-store", signal: controller.signal });
        if (cancelled || expired || !mounted.current) return;
        if (response.status === 401 || response.status === 403) {
          publish({ phase: "denied" });
          return;
        }
        if (!response.ok) throw new Error("Plan read unavailable");
        const payload: unknown = await response.json();
        if (cancelled || expired || !mounted.current) return;
        publish({ phase: "ready", plans: readPlans(payload, patientId) });
      } catch {
        if (!expired) publish({ phase: "error" });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [patientId, attempt]);

  function retry() {
    if (!mounted.current || writing.current) return;
    currentRead.current = { phase: "loading" };
    setRead(currentRead.current);
    setChoice("");
    setMessage(null);
    setAttempt((value) => value + 1);
  }

  async function save(next: number | null) {
    const current = currentRead.current;
    if (!mounted.current || writing.current || !canLink || current.phase !== "ready") return;
    // An old selection or a stale button cannot act outside the confirmed read.
    if (next === null ? planId === null || !current.plans.some((plan) => plan.id === planId)
      : !current.plans.some((plan) => plan.id === next && plan.status !== "cancelled" && plan.installmentCount > 0)) return;
    writing.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/ortho/${caseId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: next }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!mounted.current) return;
      if (!response.ok) { setMessage(payload.message ?? "تعذّر حفظ الربط."); return; }
      setChoice("");
      onChanged();
    } catch {
      if (mounted.current) setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const linked = read.phase === "ready" ? read.plans.find((plan) => plan.id === planId) ?? null : null;
  const agreements = read.phase === "ready" ? read.plans.filter((plan) => plan.status !== "cancelled" && plan.installmentCount > 0) : [];
  const missingLinked = read.phase === "ready" && planId !== null && linked === null;
  const funded = linked !== null && linked.status !== "cancelled" && linked.installmentCount > 0;
  return (
    <section aria-label="اتفاق التقويم"
      className={`mt-2 rounded-xl border px-3 py-2 text-[11px] ${funded ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
      {read.phase === "loading" ? (
        <p role="status">جارٍ التحقق من اتفاق التقويم…</p>
      ) : read.phase === "denied" ? (
        <p role="status">تعذّر عرض اتفاق التقويم بصلاحية الجلسة الحالية؛ لا يمكن تأكيد تغطية الشدّات هنا.</p>
      ) : read.phase === "error" || missingLinked ? (
        <div className="space-y-1">
          <p role="status">{missingLinked
            ? "تعذّر العثور على الخطة المربوطة ضمن القراءة الحالية؛ لا يمكن تأكيد تغطية الشدّات هنا."
            : "تعذّر تحميل اتفاق التقويم؛ هذا لا يعني عدم وجود اتفاق أو أقساط."}</p>
          <button type="button" onClick={retry}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-bold text-navy-900">
            أعد تحميل اتفاق التقويم
          </button>
        </div>
      ) : linked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-navy-900">
            {funded ? "✓ باقة تقويم: " : "مربوطة بخطة: "}{linked.title}
          </span>
          <span className="text-slate-700">
            {linked.status === "cancelled" ? "الخطة المربوطة ملغاة — راجع الاتفاق قبل متابعة الفوترة."
              : funded
                ? "الشدّات مشمولة بالأقساط — بلا عددٍ محدد ولا فاتورة لكل شدّة."
                : "الخطة بلا أقساط — الشدّات لا تُعدّ مشمولة حتى يُجدوَل الاتفاق."}
          </span>
          {canLink ? (
            <button type="button" disabled={busy} onClick={() => void save(null)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
              فكّ الربط
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-navy-900">لا اتفاق مالي مربوط بالحالة</span>
          <span className="text-slate-700">الشدّة تحتاج قرار فوترة حتى تُربط الحالة باتفاق أقساط.</span>
          {canLink && agreements.length > 0 ? (
            <>
              <select value={choice} onChange={(event) => {
                if (mounted.current && !writing.current) setChoice(event.target.value);
              }} disabled={busy} aria-label="اختر اتفاق الأقساط"
                className="max-w-full rounded-lg border border-slate-300 bg-white px-2 py-0.5">
                <option value="">اختر اتفاق الأقساط…</option>
                {agreements.map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}
              </select>
              <button type="button" disabled={busy || !choice} onClick={() => void save(Number(choice))}
                className="rounded-lg border border-navy-300 bg-white px-2 py-0.5 font-bold text-navy-900 hover:bg-navy-100 disabled:opacity-50">
                اربط
              </button>
            </>
          ) : canLink ? (
            <a href={`/patients/${patientId}?tab=plans`} className="font-bold text-navy-800 underline underline-offset-4">
              أنشئ اتفاق تقويم من تبويب الخطط
            </a>
          ) : null}
        </div>
      )}
      {message ? <p role="alert" className="mt-1 font-bold text-red-700">{message}</p> : null}
    </section>
  );
}
