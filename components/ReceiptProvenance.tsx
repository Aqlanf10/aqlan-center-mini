import { formatMoney, type Currency } from "@/lib/money";
import type { ReceiptProvenance as Provenance, ReceiptReference } from "@/lib/receipt-provenance";

function Reference({ receipt }: { receipt: ReceiptReference }) {
  return <a href={`/print/receipt/${receipt.id}`} target="_blank" rel="noopener" className="underline">
    <bdi>{receipt.receiptNumber}</bdi>
  </a>;
}

/** Shared, read-only annotations. The original face amount/date remain untouched. */
export function ReceiptProvenance({ paymentId, currency, provenance, compact = false }: {
  paymentId: number; currency: Currency; provenance?: Provenance; compact?: boolean;
}) {
  if (!provenance) return null;
  const reversal = provenance.reversal;
  const hasStatus = provenance.status === "unavailable" || provenance.correctionUnverified
    || (reversal && reversal.state !== "none") || provenance.reversalOf || provenance.replacementOf
    || provenance.correction || provenance.correctionReversal;
  if (!hasStatus) return null;
  return (
    <div data-receipt-provenance={paymentId} data-reversal-state={reversal?.state ?? "not-receipt"}
      data-correction-mode={provenance.correction?.mode ?? ""}
      data-correction-reversal={provenance.correctionReversal?.mode ?? ""}
      data-replacement-of={provenance.replacementOf?.id ?? ""}
      className={compact ? "receipt-provenance footer-note" : "receipt-provenance w-full rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-900"}>
      {provenance.status === "unavailable" ? <p>حالة السند غير متحققة.</p> : <>
        {reversal?.state === "full" ? <p>عُكس بالكامل. مبلغ السند الأصلي محفوظ كما سُجّل.</p> : null}
        {reversal?.state === "partial" && reversal.reversedMinor !== null && reversal.remainingMinor !== null ? (
          <p>عُكس جزئيًا: {formatMoney(reversal.reversedMinor, currency)}. المتبقي غير المعكوس: {formatMoney(reversal.remainingMinor, currency)}.</p>
        ) : null}
        {reversal?.state === "unverified" ? <p>حالة العكس غير متحققة.</p> : null}
        {provenance.correctionReversal ? <p>
          {provenance.correctionReversal.mode === "void" ? "قيد إبطال المتبقي من السند " : "قيد عكس لتصحيح السند "}
          <Reference receipt={provenance.correctionReversal.original} />.
        </p> : provenance.reversalOf ? <p>عكس مرتبط بالسند <Reference receipt={provenance.reversalOf} />.</p> : null}
        {provenance.replacementOf ? <p>سند بديل لتصحيح السند <Reference receipt={provenance.replacementOf} />.</p> : null}
        {provenance.correction ? <p>
          {provenance.correction.mode === "void" ? "أُبطل المتبقي بقيد " : "قيد التصحيح "}
          <Reference receipt={provenance.correction.reversal} />
          {provenance.correction.replacement ? <>، والسند البديل <Reference receipt={provenance.correction.replacement} /></> : null}.
        </p> : null}
        {provenance.correctionUnverified ? <p>تفاصيل التصحيح غير متحققة.</p> : null}
      </>}
    </div>
  );
}
