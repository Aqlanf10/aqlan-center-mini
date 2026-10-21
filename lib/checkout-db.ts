import { CLINIC_TIME_ZONE, ensureSchema, getPool, visitWalkout, type DbClient, type VisitWalkout } from "./db";
import { buildCheckoutSummary, legacyCheckoutSuggestion, type CheckoutCurrencyLine } from "./checkout-summary";
import { listLegacyBalanceArrangements } from "./legacy-balance-arrangements-db";
import { clinicDateString } from "./schedule";
import { clinicTodaySql } from "./clinic-day-sql";
import { readCheckoutDueRecommendationInSnapshot } from "./checkout-due-recommendation-db";

/**
 * (P0-G) الملخص المالي للشبّاك بكل عملة — من ملخّص المغادرة الكانوني + ترتيب الرصيد السابق (P0-C).
 * ما دُفع اليوم على الرصيد السابق يُطرح من اقتراح اليوم فلا يُقترح قسطان في زيارةٍ واحدة.
 */
export async function visitCheckoutSummary(walkout: VisitWalkout, client?: DbClient, today = clinicDateString(new Date(), CLINIC_TIME_ZONE)): Promise<CheckoutCurrencyLine[]> {
  const arrangements = walkout.patientId === null ? []
    : await listLegacyBalanceArrangements(walkout.patientId, today, false, client);
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

/** One transaction owns every financial fact returned to checkout. Standalone
 * legacy summary callers retain their existing contract; its old suggestion
 * fields are not the source-qualified recommendation or a collection target. */
export async function readVisitCheckout(visitId: number) {
  await ensureSchema();
  const client = await getPool().connect();
  let destroy = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const today = (await client.query<{ today: string }>(`SELECT ${clinicTodaySql("$1")}::text AS today`, [CLINIC_TIME_ZONE])).rows[0]?.today;
    if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("Missing checkout clinic date");
    const walkout = await visitWalkout(visitId, client);
    if (!walkout) { await client.query("COMMIT"); return null; }
    const summary = await visitCheckoutSummary(walkout, client, today);
    const dueRecommendation = walkout.patientId === null ? null : await readCheckoutDueRecommendationInSnapshot(client, {
      patientId: walkout.patientId, visitInvoiceId: walkout.invoice?.id ?? null, today,
    });
    await client.query("COMMIT");
    return { walkout, summary, dueRecommendation, today };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
