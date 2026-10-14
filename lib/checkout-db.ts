import { type VisitWalkout } from "./db";
import { buildCheckoutSummary, legacyCheckoutSuggestion, type CheckoutCurrencyLine } from "./checkout-summary";
import { listLegacyBalanceArrangements } from "./legacy-balance-arrangements-db";
import { isHandoffDate } from "./reception-handoff";

/**
 * (P0-G) الملخص المالي للشبّاك بكل عملة — من ملخّص المغادرة الكانوني + ترتيب الرصيد السابق (P0-C).
 * ما دُفع اليوم على الرصيد السابق يُطرح من اقتراح اليوم فلا يُقترح قسطان في زيارةٍ واحدة.
 */
export async function visitCheckoutSummary(walkout: VisitWalkout): Promise<CheckoutCurrencyLine[]> {
  const financialDate = walkout.checkout.financialAsOfDate;
  if (!financialDate || !isHandoffDate(financialDate)) throw new Error("Missing server financial date");
  const arrangements = walkout.patientId === null ? []
    : await listLegacyBalanceArrangements(walkout.patientId, financialDate);
  return buildCheckoutSummary({
    previous: walkout.checkout.previous,
    current: walkout.checkout.current,
    invoice: walkout.invoice
      ? { currency: walkout.invoice.currency, netMinor: walkout.invoice.netMinor, paidMinor: walkout.checkout.invoicePaidMinor }
      : null,
    paymentsToday: walkout.checkout.paymentsToday,
    legacy: arrangements
      .filter((row) => !row.progress.completed)
      .map((row) => ({
        currency: row.currency,
        suggestedMinor: legacyCheckoutSuggestion({
          cadence: row.cadence,
          suggestedMinor: row.progress.suggestedMinor,
          overdueMinor: row.progress.overdueMinor,
          paidTodayMinor: walkout.checkout.openingPaidToday.find((paid) => paid.currency === row.currency)?.netMinor ?? 0,
        }),
        remainingMinor: row.progress.arrangementRemainingMinor,
      })),
  });
}
