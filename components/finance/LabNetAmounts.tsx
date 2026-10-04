import { formatMoney } from "@/lib/money";
import type { LabNetBucket } from "@/lib/lab-balance-overview";

/** Only pass complete, successfully decoded canonical buckets. */
export function LabNetAmounts({ buckets }: { buckets: readonly LabNetBucket[] }) {
  return <div className="space-y-1 font-mono font-bold">
    {buckets.length === 0 ? <p>الرصيد الصافي صفر في جميع العملات</p> : buckets.map((bucket) => <p key={bucket.currency}>
      <bdi dir="ltr">{formatMoney(bucket.netMinor, bucket.currency)}</bdi>
    </p>)}
  </div>;
}
