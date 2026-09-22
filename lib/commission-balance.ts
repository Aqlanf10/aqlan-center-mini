import type { Currency } from "./money";

export interface CommissionBalanceLike {
  doctorId: number;
  currency: Currency;
  accruedMinor: number;
  earnedMinor: number;
  paidMinor: number;
  dueMinor: number;
  materialRateCostMinor: number;
  unratedCoveredMinor: number;
  netEarnedMinor: number;
  materialRateApplied: boolean;
  /** (P0-1) حقول المدى لتكلفة المختبر — تُصفَّر حين لا صفّ للمدى. */
  labCostMinor?: number;
  labCostNotDeductedCount?: number;
}

/**
 * يضم حركة الفترة إلى الرصيد التراكمي حتى تاريخ النهاية.
 *
 * `dueMinor` يبقى نتيجة الفترة المختارة، بينما `balanceMinor` هو الرصيد
 * التراكمي: موجب = للمركز التزام للطبيب، سالب = مديونية الطبيب للمركز.
 * الصفوف ذات الرصيد السابق تظهر حتى لو لم تكن للطبيب حركة في الفترة الحالية.
 */
export function mergeCommissionBalances<T extends CommissionBalanceLike>(
  periodRows: T[],
  cumulativeRows: T[],
): Array<T & { balanceMinor: number }> {
  const keyOf = (row: Pick<CommissionBalanceLike, "doctorId" | "currency">) =>
    `${row.doctorId}:${row.currency}`;

  const period = new Map(periodRows.map((row) => [keyOf(row), row]));
  const cumulative = new Map(cumulativeRows.map((row) => [keyOf(row), row]));
  const keys = new Set([...period.keys(), ...cumulative.keys()]);
  const result: Array<T & { balanceMinor: number }> = [];

  for (const key of keys) {
    const current = period.get(key);
    const total = cumulative.get(key);
    if (!current && (!total || total.dueMinor === 0)) continue;

    const template = (current ?? total)!;
    result.push({
      ...template,
      accruedMinor: current?.accruedMinor ?? 0,
      earnedMinor: current?.earnedMinor ?? 0,
      paidMinor: current?.paidMinor ?? 0,
      dueMinor: current?.dueMinor ?? 0,
      materialRateCostMinor: current?.materialRateCostMinor ?? 0,
      unratedCoveredMinor: current?.unratedCoveredMinor ?? 0,
      netEarnedMinor: current?.netEarnedMinor ?? 0,
      materialRateApplied: current?.materialRateApplied ?? total?.materialRateApplied ?? false,
      ...(template.labCostMinor !== undefined ? { labCostMinor: current?.labCostMinor ?? 0 } : {}),
      ...(template.labCostNotDeductedCount !== undefined
        ? { labCostNotDeductedCount: current?.labCostNotDeductedCount ?? 0 }
        : {}),
      balanceMinor: total?.dueMinor ?? 0,
    });
  }

  return result;
}
