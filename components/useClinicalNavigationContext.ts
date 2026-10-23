"use client";

import { useEffect, useMemo, useState } from "react";
import { clinicalContextSearch, isClinicalId, readClinicalContext, decodeClinicalContext, type ClinicalNavigationContext, type TreatmentSubTab } from "@/lib/patient-navigation";

export type ClinicalNavigationVerificationMode = "graph" | "assistant-visit" | "pending" | "refused";
/** Session comes from the authenticated provider, never navigation parameters. */
export function clinicalNavigationVerificationMode(session: {username:string;role:string} | null, tab: string): ClinicalNavigationVerificationMode {
  if (!session?.username.trim() || !session.role) return "pending";
  return session.role === "assistant" ? tab === "today" ? "assistant-visit" : "refused" : "graph";
}

type AcceptedContext = { context: ClinicalNavigationContext; sub: TreatmentSubTab };
export async function readVerifiedClinicalContext(patientId: number, context: ClinicalNavigationContext, signal?: AbortSignal, mode: ClinicalNavigationVerificationMode = "graph"): Promise<AcceptedContext> {
  if (mode === "pending" || mode === "refused") throw new Error("تعذّر التحقق من صلاحية سياق التنقل.");
  if (mode === "assistant-visit" && (!isClinicalId(patientId) || !isClinicalId(context.visitId)
    || (context.patientId !== undefined && context.patientId !== patientId)
    || Object.keys(context).some(key => key !== "patientId" && key !== "visitId"))) {
    throw new Error("يلزم مرجع زيارة محددة للمريض دون سياق خطة أو حالة علاجية.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new Error("انتهى سياق الطلب.");
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // This verifies only a visit identity using an already-authorized read. The server
        // retains patient access and the assistant's today-only restriction, including signed visits.
        const path = mode === "assistant-visit" ? `/api/visits/${context.visitId}/clinical`
          : `/api/patients/${patientId}/clinical-context?${clinicalContextSearch(context)}`;
        const response = await fetch(path, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("تعذّر التحقق من مرجع العلاج. لم يتم اختيار حالة بديلة.");
        const payload: unknown = await response.json();
        if (mode === "assistant-visit") {
          const visit = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
          if (controller.signal.aborted || !visit || visit.id !== context.visitId || visit.patientId !== patientId
            || (visit.status !== "open" && visit.status !== "signed")) throw new Error("تعذّر التحقق من هوية الزيارة والمريض.");
          // Deliberate allowlist: do not reconstruct a denied treatment/financial graph from this response.
          return { context: {patientId, visitId: context.visitId}, sub: "cases" as const };
        }
        const accepted = decodeClinicalContext(payload, patientId, context);
        if (controller.signal.aborted || !accepted) throw new Error("تعذّر التحقق من هوية العلاج ومجاله.");
        return { context: accepted.context, sub: accepted.sub };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("تعذّر إكمال التحقق من مرجع العلاج. أعد المحاولة.")); }, 15_000);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** State is never authoritative for another patient, principal, role, permission snapshot or URL. */
export function useClinicalNavigationContext(patientId: number, context: ClinicalNavigationContext | undefined, invalid: boolean, authority: string, mode: ClinicalNavigationVerificationMode) {
  const search = clinicalContextSearch(context ?? {});
  const key = JSON.stringify([patientId, authority, search, invalid, mode]);
  const owner = useMemo(() => ({ key }), [key]);
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; accepted?: AcceptedContext; error?: string }>();
  useEffect(() => {
    if (!search || invalid || mode === "pending" || mode === "refused") return;
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => {
      if (!current) return;
      current = false; controller.abort();
      setSnapshot({ owner, error: "تعذّر إكمال التحقق من مرجع العلاج. أعد تحميل الصفحة أو اختر الحالة صراحةً." });
    }, 15_000);
    const parsed = readClinicalContext(new URLSearchParams(search));
    if (parsed.contextError || !parsed.context) { clearTimeout(timeout); return; }
    void readVerifiedClinicalContext(patientId, parsed.context, controller.signal, mode).then((accepted) => {
      if (current) { clearTimeout(timeout); setSnapshot({ owner, accepted }); }
    }).catch(() => { if (current) { clearTimeout(timeout); setSnapshot({ owner, error: "تعذّر التحقق من مرجع العلاج. لم يتم اختيار حالة بديلة." }); } });
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [patientId, search, invalid, owner, mode]);
  if (invalid) return { ready: false, context: undefined, error: "مرجع العلاج في الرابط غير صالح. اختر الحالة صراحةً." };
  if (!search) return { ready: true, context: undefined, error: undefined };
  if (mode === "pending") return { ready: false, context: undefined, error: undefined };
  if (mode === "refused") return { ready: false, context: undefined, error: "مرجع الزيارة متاح من تبويب اليوم فقط لهذا الدور." };
  if (snapshot?.owner !== owner) return { ready: false, context: undefined, error: undefined };
  return { ready: !!snapshot.accepted, context: snapshot.accepted?.context, error: snapshot.error };
}
