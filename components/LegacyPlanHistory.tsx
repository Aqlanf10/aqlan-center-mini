import { formatMoney, type Currency } from "@/lib/money";
import { legacyConsentIsCurrent, legacyCoverageIsLive, legacyCoverageLabel, readLegacyCoverageSite, type HistoricalPlanItem } from "./legacy-treatment-view";

/** Original monetary facts are not a synthetic session schedule or historical progress assessment. */
export function LegacyPlanHistory({ items, currency, canSeeFinancial, consented }: {
  items: readonly (HistoricalPlanItem & { id: number; serviceName: string; toothCode: number | null; totalMinor: number })[];
  currency: Currency; canSeeFinancial: boolean; consented: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="legacy-plan-items" className="mb-3 space-y-2">
      {items.map((item) => (
        <li key={item.id} className="rounded-xl border border-indigo-200 bg-indigo-50 p-2.5 text-xs">
          <p className="font-extrabold">{item.serviceName} · حالة بدأت قبل النظام</p>
          {item.legacyCoverageState === "verified" && readLegacyCoverageSite(item.legacyCoverageSite) ? (
            <p data-testid={`legacy-plan-coverage-${item.id}`} className="mt-1">
              التغطية المحفوظة عند التسجيل: {legacyCoverageLabel(readLegacyCoverageSite(item.legacyCoverageSite)!)}
            </p>
          ) : (
            <p role="status" data-testid={`legacy-plan-coverage-unknown-${item.id}`} className="mt-1 font-bold text-amber-900">
              {item.legacyCoverageState === "conflict" ? "تعارض في بيانات التغطية التاريخية." : "نطاق التغطية التاريخية غير معلوم؛ لا توجد لقطة تغطية موثوقة."}
              {" "}يلزم التحقق قبل توقيع الزيارة. تاريخ الموافقة المخزّن وحده لا يثبت موافقة حالية.
            </p>
          )}
          {canSeeFinancial ? <p className="mt-1">المتفق عليه تاريخيًّا: {formatMoney(item.totalMinor, currency)} (ليس تقديرًا لباقي العمل أو دَينًا جديدًا)</p> : null}
          <p className="mt-1">تقدّم العلاج السابق غير معلوم؛ لا جلسات تاريخية مفترضة.</p>
          {legacyCoverageIsLive(item) ? (
            <p className="mt-1 text-indigo-900">مشمول بالاتفاق التاريخي الحيّ.
              {!legacyConsentIsCurrent(item, consented) ? " يلزم استكمال الموافقة الفعلية قبل توقيع الزيارة؛ حفظ المسودة متاح." : ""}
            </p>
          ) : (
            <p role="status" data-testid={`plan-item-financial-review-${item.id}`} className="mt-1 font-bold text-amber-900">
              {item.legacyAgreementStatus === "void" ? "الاتفاق مُبطَل مع بقاء هويته التاريخية. " : ""}
              يحتاج مراجعة مالية — لا تُنشأ فاتورة جديدة لهذا البند، ولا يُوقَّع العمل المرتبط قبل حسمها. حفظ المسودة متاح.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
