import type { ClinicalProgressView } from "@/lib/historical-clinical-projection";
import { formatMoney, type Currency } from "@/lib/money";

export function HistoricalClinicalNote({ progress, currency }: { progress: ClinicalProgressView; currency: Currency }) {
  return <span data-testid="historical-clinical-note">
    تقدّم العلاج السابق والباقي السريري غير معلومين؛ الاتفاق التاريخي سجل مالي وليس تقديرًا للعمل المتبقي.
    {progress.knownItems > 0 ? ` · العمل المعروف خارج البنود التاريخية: ${progress.knownDoneItems} من ${progress.knownItems} إجراءات · باقي علاج معروف (غير مستحق): ${formatMoney(progress.knownRemainingMinor, currency)}` : ""}
  </span>;
}
