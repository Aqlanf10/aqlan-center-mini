/** Scheduled/visit due is not the legacy UI's optional next-payment suggestion.
 * The monthly progress reader already includes every due date through today
 * and subtracts settled receipts once. Per-visit receipts must be subtracted
 * from the original installment, before capping at the current source position. */
export function legacyCheckoutDueNow(input: {
  cadence: "monthly" | "per_visit";
  installmentMinor: number;
  remainingMinor: number;
  overdueMinor: number;
  paidTodayMinor: number;
  firstDueDate: string | null;
  today: string;
}): number | null {
  const validDate = (value: string | null): value is string => {
    if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(input.today) || ![input.installmentMinor, input.remainingMinor, input.overdueMinor, input.paidTodayMinor].every(Number.isSafeInteger)
    || input.installmentMinor <= 0 || input.remainingMinor < 0 || input.overdueMinor < 0 || input.overdueMinor > input.remainingMinor) return null;
  if (input.cadence === "monthly") {
    if (!validDate(input.firstDueDate) || input.firstDueDate > input.today && input.overdueMinor !== 0) return null;
    return input.overdueMinor;
  }
  if (input.cadence !== "per_visit") return null;
  return Math.min(input.remainingMinor, Math.max(0, input.installmentMinor - Math.max(0, input.paidTodayMinor)));
}
