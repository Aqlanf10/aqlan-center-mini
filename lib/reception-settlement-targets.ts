import { isCurrency, type Currency } from "./money";

interface PlanTarget {
  id: number;
  title: string;
  status?: string;
  baseCurrency?: Currency;
  legacy?: boolean;
}
interface OpeningTarget {
  currency?: Currency;
  amountMinor: number;
}

/** Match the canonical patient-ledger collection policy; historical plans are
 * not new settlement targets. Offer their existing opening balance by currency. */
export function receptionSettlementTargets(data: {
  plans: PlanTarget[];
  openings?: OpeningTarget[];
  balances?: Partial<Record<Currency, { dueMinor: number }>>;
}) {
  const plans = data.plans
    .filter((plan) => plan.status === "active" && !plan.legacy && isCurrency(plan.baseCurrency))
    .map(({ id, title, baseCurrency }) => ({ id, title, baseCurrency }));
  const openings = (Array.isArray(data.openings) ? data.openings : []).flatMap((opening) => {
    const currency = opening.currency;
    if (!isCurrency(currency)) return [];
    const due = data.balances?.[currency]?.dueMinor;
    if (typeof due !== "number" || !Number.isSafeInteger(due) || due <= 0 ||
        !Number.isSafeInteger(opening.amountMinor) || opening.amountMinor <= 0) return [];
    return [{ currency, dueMinor: Math.min(opening.amountMinor, due) }];
  });
  return { plans, openings };
}
