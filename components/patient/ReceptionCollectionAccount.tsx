"use client";

import { useEffect, useState } from "react";
import type { readReceptionCollectionLedger } from "@/lib/reception-collection-ledger";
import { formatMoney } from "@/lib/money";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { ReceptionDebtRepayments } from "./ReceptionDebtRepayments";
import { CheckoutDueSummary } from "./CheckoutDueSummary";

type Ledger = Awaited<ReturnType<typeof readReceptionCollectionLedger>>;
export function ReceptionCollectionAccount({ patientId, patientName, actor }: { patientId: number; patientName: string; actor: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [message, setMessage] = useState("");
  const [debtHeld, setDebtHeld] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLedger(null);
      setMessage("");
      try {
        const response = await fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body.patientId !== patientId) throw new Error(body.message || "تعذّر تحميل بيانات التحصيل.");
        if (!controller.signal.aborted) setLedger(body);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "تعذّر تحميل بيانات التحصيل.");
      }
    }
    void load();
    return () => controller.abort();
  }, [patientId, revision]);
  if (!ledger) return <p role="status">{message || "جارٍ تحميل الحساب…"}</p>;
  return <section className="space-y-4 rounded-xl bg-white p-4">
    <CheckoutDueSummary recommendation={ledger.dueRecommendation} />
    <button type="button" disabled={debtHeld} className="rounded-lg bg-emerald-700 px-4 py-2 text-white" onClick={() => setCollecting(true)}>تسجيل تحصيل</button>
    {!collecting && <ReceptionDebtRepayments patientId={patientId} actor={actor} revision={revision}
      onHold={setDebtHeld} onChanged={() => setRevision(previous => previous + 1)} />}
    {ledger.payments.length > 0 && <ul aria-label="سندات قبض الموظف لهذا المريض">
      {ledger.payments.map(row => <li key={row.id}><a className="underline" href={`/print/receipt/${row.id}`} target="_blank" rel="noopener">
        طباعة {row.receiptNumber} · {formatMoney(row.amountMinor, row.currency)}
      </a></li>)}
    </ul>}
    <CollectPaymentModal patientId={patientId} patientName={patientName} isOpen={collecting} invoices={ledger.invoices}
      plans={ledger.plans} openings={ledger.openings} onClose={() => setCollecting(false)}
      onSuccess={() => { setCollecting(false); setRevision(previous => previous + 1); }} />
  </section>;
}
