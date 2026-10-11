"use client";

import { useEffect, useMemo, useState } from "react";
import { clinicalContextSearch, readClinicalContext, decodeClinicalContext, type ClinicalNavigationContext, type TreatmentSubTab } from "@/lib/patient-navigation";
import type { VerifiedPillarContext } from "@/lib/ortho-pillar-navigation";

type AcceptedContext = { context: ClinicalNavigationContext; sub: TreatmentSubTab };
export async function readVerifiedClinicalContext(patientId: number, context: ClinicalNavigationContext, signal?: AbortSignal): Promise<AcceptedContext> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new Error("انتهى سياق الطلب.");
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`/api/patients/${patientId}/clinical-context?${clinicalContextSearch(context)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("تعذّر التحقق من مرجع العلاج. لم يتم اختيار حالة بديلة.");
        const accepted = decodeClinicalContext(await response.json(), patientId, context);
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
export function useClinicalNavigationContext(patientId: number, context: ClinicalNavigationContext | undefined, invalid: boolean, authority: string, verifiedPillar?: VerifiedPillarContext) {
  const search = clinicalContextSearch(context ?? {});
  const key = JSON.stringify([patientId, authority, search, invalid]);
  const owner = useMemo(() => ({ key }), [key]);
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; accepted?: AcceptedContext; error?: string }>();
  // Only the page's synchronous, exact-tuple transition supplies this receipt.
  // It belongs to one accepted location; popstate and different identities do not inherit it.
  const verified = !invalid && verifiedPillar?.patientId === patientId && verifiedPillar.authority === authority
    && verifiedPillar.context.patientId === patientId && verifiedPillar.context.orthoCaseId !== undefined
    && clinicalContextSearch(verifiedPillar.context) === search ? verifiedPillar : undefined;
  useEffect(() => {
    if (!search || invalid || verified) return;
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => {
      if (!current) return;
      current = false; controller.abort();
      setSnapshot({ owner, error: "تعذّر إكمال التحقق من مرجع العلاج. أعد تحميل الصفحة أو اختر الحالة صراحةً." });
    }, 15_000);
    const parsed = readClinicalContext(new URLSearchParams(search));
    if (parsed.contextError || !parsed.context) { clearTimeout(timeout); return; }
    void readVerifiedClinicalContext(patientId, parsed.context, controller.signal).then((accepted) => {
      if (current) { clearTimeout(timeout); setSnapshot({ owner, accepted }); }
    }).catch(() => { if (current) { clearTimeout(timeout); setSnapshot({ owner, error: "تعذّر التحقق من مرجع العلاج. لم يتم اختيار حالة بديلة." }); } });
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [patientId, search, invalid, owner, verified]);
  if (invalid) return { ready: false, context: undefined, error: "مرجع العلاج في الرابط غير صالح. اختر الحالة صراحةً." };
  if (!search) return { ready: true, context: undefined, error: undefined };
  if (verified) return { ready: true, context: verified.context, error: undefined };
  if (snapshot?.owner !== owner) return { ready: false, context: undefined, error: undefined };
  return { ready: !!snapshot.accepted, context: snapshot.accepted?.context, error: snapshot.error };
}
