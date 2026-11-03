"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";

export const ORTHO_PACKAGE_READ_TIMEOUT_MS = 15_000;

interface PlanOption {
  id: number;
  title: string;
  status: "active" | "completed" | "cancelled";
  installmentCount: number;
  /** Money-free: the full principal was explicitly approved (invoice-backed agreement). */
  approved: boolean;
}
// Use the same eligibility for presentation and the confirmed-read mutation guard.
// An approved principal is the agreement; installments are its optional schedule.
function fundsCase(plan: PlanOption): boolean {
  return plan.status !== "cancelled" && (plan.approved || plan.installmentCount > 0);
}

type ReadState = { phase: "ready"; plans: PlanOption[]; observedVersion: string; currentPlanId: number | null; editable: boolean } | { phase: "loading" | "error" | "denied" };
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
      || row.agreementApproved !== undefined && typeof row.agreementApproved !== "boolean"
      || row.installments.some((one) => !one || typeof one !== "object" || Array.isArray(one)
        || !Number.isSafeInteger(one.id) || one.id <= 0)) {
      throw new Error("Invalid patient plan");
    }
    ids.add(Number(row.id));
    return { id: Number(row.id), title: row.title, status: row.status as PlanOption["status"],
      installmentCount: row.installments.length, approved: row.agreementApproved === true };
  });
}

/**
 * Compatibility reference only. Invoice/historical source and adjustment scope
 * are read separately; the old plan field must never declare overall absence.
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
  const [uncertain, setUncertain] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const verificationRequested = useRef(false);
  const uncertainRef = useRef(false);
  const reconciledVersion = useRef<string | null>(null);
  const [intent, setIntent] = useState<{ from: number | null; to: number | null } | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const writing = useRef(false);
  const currentRead = useRef<ReadState>({ phase: "loading" });

  // Retire old handlers at commit, before another patient's effects can run.
  useLayoutEffect(() => {
    generation.current += 1;
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    const lease = generation.current;
    let cancelled = false;
    let expired = false;
    const controller = new AbortController();
    const publish = (next: ReadState) => {
      if (cancelled || !mounted.current || generation.current !== lease) return;
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
        if (cancelled || expired || !mounted.current || generation.current !== lease) return;
        if (response.status === 401 || response.status === 403) {
          publish({ phase: "denied" });
          return;
        }
        if (!response.ok) throw new Error("Plan read unavailable");
        const payload: unknown = await response.json();
        if (cancelled || expired || !mounted.current || generation.current !== lease) return;
        const plans = readPlans(payload, patientId);
        const observationResponse = await fetch(`/api/ortho/${caseId}/plan-link`, { cache: "no-store", signal: controller.signal });
        if (cancelled || expired || !mounted.current || generation.current !== lease) return;
        if (observationResponse.status === 401 || observationResponse.status === 403) { publish({ phase: "denied" }); return; }
        if (!observationResponse.ok) throw new Error("Link observation unavailable");
        const observation = await observationResponse.json();
        if (cancelled || expired || !mounted.current || generation.current !== lease) return;
        if (observation?.caseId !== caseId || observation.patientId !== patientId
          || typeof observation.observedVersion !== "string" || !/^[a-f0-9]{64}$/.test(observation.observedVersion)
          || observation.planId !== null && (!Number.isSafeInteger(observation.planId) || observation.planId <= 0)
          || !["active", "retention", "completed", "discontinued"].includes(observation.status)) throw new Error("Invalid link observation");
        publish({ phase: "ready", plans, observedVersion: observation.observedVersion,
          currentPlanId: observation.planId, editable: ["active", "retention"].includes(observation.status) });
        if (verificationRequested.current) { reconciledVersion.current = observation.observedVersion; setReconciled(true); }
      } catch {
        if (!expired) publish({ phase: "error" });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [patientId, caseId, attempt]);

  function retry() {
    if (!mounted.current || writing.current) return;
    if (uncertainRef.current) { verificationRequested.current = true; reconciledVersion.current = null; setReconciled(false); }
    currentRead.current = { phase: "loading" };
    setRead(currentRead.current);
    setChoice("");
    setMessage(null);
    setAttempt((value) => value + 1);
  }

  async function save(next: number | null, observedVersion: string) {
    const current = currentRead.current;
    if (!mounted.current || writing.current || !canLink || uncertainRef.current || current.phase !== "ready" || !current.editable || current.observedVersion !== observedVersion) return;
    // An old selection or a stale button cannot act outside the confirmed read.
    if (next === null ? current.currentPlanId === null || !current.plans.some((plan) => plan.id === current.currentPlanId)
      : !current.plans.some((plan) => plan.id === next && fundsCase(plan))) return;
    const lease = generation.current;
    writing.current = true;
    setBusy(true);
    verificationRequested.current = false; setReconciled(false);
    setIntent({ from: current.currentPlanId, to: next });
    setMessage(null);
    try {
      const response = await fetch(`/api/ortho/${caseId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: next, expectedVersion: current.observedVersion }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string; ok?: unknown; caseId?: unknown; planId?: unknown; changed?: unknown };
      if (!mounted.current || generation.current !== lease) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { currentRead.current = { phase: "denied" }; setRead(currentRead.current); }
        if (response.status >= 500 || response.status === 409) { uncertainRef.current = true; setUncertain(true); }
        setMessage(payload.message ?? "تعذّر حفظ الربط."); return;
      }
      if (payload.ok !== true || payload.caseId !== caseId || payload.planId !== next || typeof payload.changed !== "boolean") {
        uncertainRef.current = true; setUncertain(true);
        setMessage("تعذّر تأكيد نتيجة الربط. تحقّق من الحالة قبل أي طلب جديد."); return;
      }
      setChoice("");
      setIntent(null);
      currentRead.current = { phase: "loading" }; setRead(currentRead.current);
      setAttempt(value => value + 1);
      onChanged();
    } catch {
      if (mounted.current && generation.current === lease) { uncertainRef.current = true; setUncertain(true); setMessage("تعذّر تأكيد نتيجة الربط. تحقّق من الحالة قبل أي طلب جديد."); }
    } finally {
      if (generation.current === lease) { writing.current = false; if (mounted.current) setBusy(false); }
    }
  }

  const linked = read.phase === "ready" ? read.plans.find((plan) => plan.id === read.currentPlanId) ?? null : null;
  const agreements = read.phase === "ready" ? read.plans.filter(fundsCase) : [];
  const missingLinked = read.phase === "ready" && read.currentPlanId !== null && linked === null;
  const funded = linked !== null && fundsCase(linked);
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
            {funded ? linked.approved ? "✓ اتفاق معتمد بكامل الأصل: " : "✓ رابط اتفاق أقساط قديم: " : "رابط خطة قديم: "}{linked.title}
          </span>
          <span className="text-slate-700">
            {linked.status === "cancelled" ? "الخطة المربوطة ملغاة — راجع الاتفاق قبل متابعة الفوترة."
              : funded
                ? linked.approved
                  ? "الاتفاق المعتمد هو أصل العلاج؛ الأقساط إن وُجدت جدول تحصيل فقط ولا تُشترط لشمول الشدّة."
                  : "رابط قائم محفوظ للتوافق؛ مرجع العلاج وشمول الشدّة يُعرضان بصورة مستقلة أعلاه."
                : "الخطة بلا أقساط؛ هذا وحده لا ينفي مرجع الفاتورة أو الاتفاق السابق ولا يحدد شمول الشدّة."}
          </span>
          {canLink && !uncertain && read.phase === "ready" && read.editable ? (
            <button type="button" disabled={busy} onClick={() => void save(null, read.observedVersion)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
              فكّ الربط
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-navy-900">لم تُربط خطة علاج بهذه الحالة</span>
          <span className="text-slate-700">اختر اتفاقًا معتمدًا قائمًا أو مرجع أقساط قائمًا فقط. الربط لا ينشئ فاتورة ولا يثبت السداد؛ راجع مرجع الحالة وشمول الشدّة أعلاه.</span>
          {canLink && !uncertain && read.phase === "ready" && read.editable && agreements.length > 0 ? (
            <>
              <select value={choice} onChange={(event) => {
                if (mounted.current && !writing.current) setChoice(event.target.value);
              }} disabled={busy} aria-label="اختر اتفاقًا قائمًا"
                className="max-w-full rounded-lg border border-slate-300 bg-white px-2 py-0.5">
                <option value="">اختر اتفاقًا قائمًا…</option>
                {agreements.map((plan) => <option key={plan.id} value={plan.id}>{plan.approved ? `${plan.title} — اتفاق معتمد` : plan.title}</option>)}
              </select>
              <button type="button" disabled={busy || !choice} onClick={() => void save(Number(choice), read.observedVersion)}
                className="rounded-lg border border-navy-300 bg-white px-2 py-0.5 font-bold text-navy-900 hover:bg-navy-100 disabled:opacity-50">
                اربط
              </button>
            </>
          ) : null}
        </div>
      )}
      {uncertain ? <div className="mt-2 space-y-2 rounded-lg border border-amber-400 p-2" role="status">
        <p>نتيجة الطلب تحتاج مراجعة؛ لن نعيد الإرسال تلقائيًا.</p>
        {intent ? <p>الطلب السابق: {intent.from === null ? "بلا رابط" : `خطة #${intent.from}`} ← {intent.to === null ? "فك الربط" : `خطة #${intent.to}`}</p> : null}
        <button type="button" disabled={busy || read.phase === "loading"} onClick={retry}>تحقق من الارتباط الحالي</button>
        {reconciled && read.phase === "ready" ? <p>القراءة الحالية: {read.currentPlanId === null ? "بلا رابط" : `خطة #${read.currentPlanId}`} — تطابقها مع الطلب لا يثبت وحده مَن نفّذه.</p> : null}
        {reconciled && read.phase === "ready" ? <button type="button" disabled={busy} onClick={() => {
          if (!mounted.current || writing.current || currentRead.current.phase !== "ready" || reconciledVersion.current !== currentRead.current.observedVersion) return;
          uncertainRef.current = false; reconciledVersion.current = null;
          verificationRequested.current = false; setReconciled(false);
          setUncertain(false); setIntent(null); setChoice(""); setMessage(null);
        }}>راجعت النتيجة؛ ابدأ اختيارًا جديدًا</button> : null}
      </div> : null}
      {message ? <p role="alert" className="mt-1 font-bold text-red-700">{message}</p> : null}
    </section>
  );
}
