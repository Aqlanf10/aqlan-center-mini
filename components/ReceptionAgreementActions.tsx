"use client";

import { useCallback, useEffect, useState } from "react";
import { ApprovedAgreementPanel } from "./ApprovedAgreementPanel";
import type { Currency } from "@/lib/money";

type Plan = { id: number; totalMinor: number; currency: Currency };
type Link = { id: number; planId: number };
type Actions = { plans: Plan[]; links: Link[] };

export function ReceptionAgreementActions({ patientId, view }: { patientId: number; view: "approval" | "links" }) {
  const [actions, setActions] = useState<Actions | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/patients/${patientId}?projection=agreement-${view}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("تعذّر تحميل إجراءات الاتفاق.");
      const result: Actions = await response.json();
      if (!signal?.aborted) { setActions(result); setError(""); }
    } catch {
      if (!signal?.aborted) { setActions(null); setError("تعذّر تحميل إجراءات الاتفاق. أعد فتح التبويب للمحاولة."); }
    }
  }, [patientId, view]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function unlink(link: Link) {
    setBusy(true);
    try {
      const response = await fetch(`/api/ortho/${link.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: null }),
      });
      if (!response.ok) throw new Error((await response.json()).message);
      await load();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "تعذّر تأكيد فكّ الربط. أعد فتح التبويب للتحقق.");
    } finally { setBusy(false); }
  }

  return <section className="space-y-3" aria-label="إجراءات الاتفاق المالي">
    {error && <p role="alert">{error}</p>}
    {!actions && !error && <p role="status">جارٍ تحميل إجراءات الاتفاق…</p>}
    {actions && actions.plans.length === 0 && actions.links.length === 0 && <p>لا توجد اتفاقات متاحة لهذا الإجراء.</p>}
    {actions?.plans.map(plan => <div key={plan.id}>
      <h3 className="font-bold">خطة رقم {plan.id}</h3>
      <ApprovedAgreementPanel planId={plan.id} totalMinor={plan.totalMinor} currency={plan.currency}
        position={null} canApprove isAdmin={false} onChanged={load} />
    </div>)}
    {actions?.links.map(link => <div key={link.id} className="flex items-center gap-3">
      <span>حالة رقم {link.id} · اتفاق رقم {link.planId}</span>
      <button className="rounded-lg border px-3 py-1" type="button" disabled={busy} onClick={() => void unlink(link)}>فكّ الربط</button>
    </div>)}
  </section>;
}
