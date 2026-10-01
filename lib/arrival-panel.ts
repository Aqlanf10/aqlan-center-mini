import { CURRENCIES, type Currency } from "./money";

/**
 * (P0-D) لوحة الوصول المالية للاستقبال — المنطق الخالص.
 *
 * عند «وصل» يرى الاستقبال لوحةً واحدة: ما المتوقع اليوم، والحالة النشطة، والمال **بكل عملة على حدة**
 * (لا جمع بين العملات أبدًا)، واقتراح التحصيل من مصدره الصحيح:
 *  - ترتيب الرصيد السابق (P0-C) ⇒ يُدفع على `opening_currency` فينقص الرصيد القديم، بلا فاتورة جديدة؛
 *  - قسط خطة علاج ممولة باتفاق (BILL-1) ⇒ مسار تسجيل القسط القائم.
 * الدفع ليس شرطًا للدخول: اللوحة معلومةٌ واقتراح، و`ops.require_clearance_before_call` لا يُمسّ.
 */

export type ArrivalSource = "opening" | "invoice" | "plan";

export interface ArrivalLegacyLine {
  arrangementId: number;
  cadence: "per_visit" | "monthly";
  /** القسط المقترح اليوم (لا يتجاوز المتبقي من الرصيد القديم). */
  suggestedMinor: number;
  overdueMinor: number;
  nextDueDate: string | null;
  remainingMinor: number;
}

export interface ArrivalPlanLine {
  planId: number;
  title: string;
  overdueMinor: number;
  nextDueDate: string | null;
  nextDueAmountMinor: number;
}

export interface ArrivalCurrencyLine {
  currency: Currency;
  /** الرصيد الكانوني بهذه العملة: موجب = مستحق على المريض، سالب = رصيدٌ دائن له. */
  balanceMinor: number;
  /** المتبقي من الرصيد السابق (قبل النظام) بهذه العملة — جزءٌ من الرصيد لا إضافةٌ إليه. */
  openingRemainingMinor: number;
  legacy: ArrivalLegacyLine | null;
  /** أقساط خطط الاتفاق بهذه العملة المستحقة اليوم أو المتأخرة. */
  planInstallments: ArrivalPlanLine[];
  openInvoices: number;
  /** من أين جاء رصيد هذه العملة — لتمييز «رصيد قديم» عن «علاج جديد» على الشاشة. */
  sources: ArrivalSource[];
}

export interface ArrivalSuggestion {
  kind: "legacy" | "plan";
  currency: Currency;
  amountMinor: number;
  /** لقسط الخطة: رقم الخطة لمسار تسجيل القسط؛ للرصيد السابق: null (الهدف opening_currency). */
  planId: number | null;
  label: string;
}

export function buildArrivalCurrencyLines(input: {
  today: string;
  balances: readonly { currency: Currency; dueMinor: number }[];
  openings: readonly { currency: Currency; remainingMinor: number }[];
  arrangements: readonly {
    id: number; currency: Currency; cadence: "per_visit" | "monthly";
    progress: { suggestedMinor: number; overdueMinor: number; nextDueDate: string | null; arrangementRemainingMinor: number; completed: boolean };
  }[];
  plans: readonly {
    id: number; title: string; baseCurrency: Currency; status: string; installmentCount: number;
    progress: { overdueMinor: number; nextDueDate: string | null; nextDueAmountMinor: number };
  }[];
  openInvoices: readonly { currency: Currency; count: number }[];
}): ArrivalCurrencyLine[] {
  const lines: ArrivalCurrencyLine[] = [];
  for (const currency of CURRENCIES) {
    const balanceMinor = input.balances.find((row) => row.currency === currency)?.dueMinor ?? 0;
    const openingRemainingMinor = Math.max(0, input.openings.find((row) => row.currency === currency)?.remainingMinor ?? 0);
    const arrangement = input.arrangements.find((row) => row.currency === currency && !row.progress.completed) ?? null;
    const planInstallments = input.plans
      .filter((plan) => plan.baseCurrency === currency && plan.status === "active" && plan.installmentCount > 0)
      .filter((plan) => plan.progress.overdueMinor > 0
        || (plan.progress.nextDueDate !== null && plan.progress.nextDueDate <= input.today && plan.progress.nextDueAmountMinor > 0))
      .map((plan) => ({
        planId: plan.id, title: plan.title, overdueMinor: plan.progress.overdueMinor,
        nextDueDate: plan.progress.nextDueDate, nextDueAmountMinor: plan.progress.nextDueAmountMinor,
      }));
    const openInvoices = input.openInvoices.find((row) => row.currency === currency)?.count ?? 0;
    const sources: ArrivalSource[] = [];
    if (openingRemainingMinor > 0) sources.push("opening");
    if (openInvoices > 0) sources.push("invoice");
    if (input.plans.some((plan) => plan.baseCurrency === currency && plan.status === "active" && plan.installmentCount > 0)) sources.push("plan");
    if (balanceMinor === 0 && openingRemainingMinor === 0 && !arrangement && planInstallments.length === 0 && openInvoices === 0) continue;
    lines.push({
      currency, balanceMinor, openingRemainingMinor, openInvoices, planInstallments, sources,
      legacy: arrangement ? {
        arrangementId: arrangement.id, cadence: arrangement.cadence,
        suggestedMinor: arrangement.progress.suggestedMinor, overdueMinor: arrangement.progress.overdueMinor,
        nextDueDate: arrangement.progress.nextDueDate, remainingMinor: arrangement.progress.arrangementRemainingMinor,
      } : null,
    });
  }
  return lines;
}

/**
 * الاقتراحات بعملاتها — اقتراحٌ لكل مصدرٍ قائم، لا مبلغٌ مجمّع. الرصيد السابق: المتأخر الشهري
 * إن وُجد وإلا القسط المقترح. قسط الخطة: المتأخر وإلا قسط اليوم.
 */
export function arrivalSuggestions(lines: readonly ArrivalCurrencyLine[]): ArrivalSuggestion[] {
  const suggestions: ArrivalSuggestion[] = [];
  for (const line of lines) {
    if (line.legacy) {
      const amount = Math.min(line.openingRemainingMinor, Math.max(line.legacy.overdueMinor, line.legacy.suggestedMinor));
      if (amount > 0) suggestions.push({ kind: "legacy", currency: line.currency, amountMinor: amount, planId: null, label: "قسط الرصيد السابق" });
    }
    for (const plan of line.planInstallments) {
      const amount = plan.overdueMinor > 0 ? plan.overdueMinor : plan.nextDueAmountMinor;
      if (amount > 0) suggestions.push({ kind: "plan", currency: line.currency, amountMinor: amount, planId: plan.planId, label: `قسط ${plan.title}` });
    }
  }
  return suggestions;
}
