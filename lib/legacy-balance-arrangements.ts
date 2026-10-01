import type { Currency } from "./money";

export type LegacyArrangementCadence = "per_visit" | "monthly";

export interface LegacyBalanceArrangement {
  id: number;
  patientId: number;
  currency: Currency;
  cadence: LegacyArrangementCadence;
  installmentMinor: number;
  startingDueMinor: number;
  firstDueDate: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface LegacyArrangementProgress {
  currentOpeningDueMinor: number;
  paidSinceStartMinor: number;
  arrangementRemainingMinor: number;
  suggestedMinor: number;
  overdueMinor: number;
  nextDueDate: string | null;
  nextDueAmountMinor: number;
  completed: boolean;
}

export function isLegacyArrangementCadence(value: unknown): value is LegacyArrangementCadence {
  return value === "per_visit" || value === "monthly";
}

function isoDate(year: number, monthOneBased: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthOneBased).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addMonthsClamped(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonthZero = monthIndex - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthZero + 1, 0)).getUTCDate();
  return isoDate(targetYear, targetMonthZero + 1, Math.min(day, lastDay));
}

function dueCountThrough(firstDueDate: string, today: string, totalCount: number): number {
  if (today < firstDueDate || totalCount <= 0) return 0;
  const [fy, fm] = firstDueDate.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (months < 0) return 0;
  if (addMonthsClamped(firstDueDate, months) > today) months -= 1;
  return Math.max(0, Math.min(totalCount, months + 1));
}

/**
 * ترتيب الرصيد القديم لا يملك principal خاصًا به.
 * startingDueMinor لقطة عند الاتفاق، وcurrentOpeningDueMinor هو الحقيقة الحالية.
 * لذلك لا يستطيع الاتفاق أن يزيد الدين حتى لو عُدّل الرصيد لاحقًا.
 */
export function legacyArrangementProgress(input: {
  startingDueMinor: number;
  installmentMinor: number;
  cadence: LegacyArrangementCadence;
  firstDueDate: string | null;
  currentOpeningDueMinor: number;
  paidSinceStartMinor: number;
  today: string;
}): LegacyArrangementProgress {
  const starting = Math.max(0, Math.round(input.startingDueMinor));
  const installment = Math.max(1, Math.round(input.installmentMinor));
  const paid = Math.max(0, Math.min(starting, Math.round(input.paidSinceStartMinor)));
  const byAgreement = Math.max(0, starting - paid);
  const currentOpening = Math.max(0, Math.round(input.currentOpeningDueMinor));
  const remaining = Math.min(currentOpening, byAgreement);
  const suggested = Math.min(installment, remaining);

  if (remaining <= 0) {
    return {
      currentOpeningDueMinor: currentOpening,
      paidSinceStartMinor: paid,
      arrangementRemainingMinor: 0,
      suggestedMinor: 0,
      overdueMinor: 0,
      nextDueDate: null,
      nextDueAmountMinor: 0,
      completed: true,
    };
  }

  if (input.cadence === "per_visit" || !input.firstDueDate) {
    return {
      currentOpeningDueMinor: currentOpening,
      paidSinceStartMinor: paid,
      arrangementRemainingMinor: remaining,
      suggestedMinor: suggested,
      overdueMinor: 0,
      nextDueDate: null,
      nextDueAmountMinor: suggested,
      completed: false,
    };
  }

  const totalCount = Math.max(1, Math.ceil(starting / installment));
  const dueCount = dueCountThrough(input.firstDueDate, input.today, totalCount);
  const dueToDateMinor = Math.min(starting, dueCount * installment);
  const overdueMinor = Math.min(remaining, Math.max(0, dueToDateMinor - paid));

  const completedInstallments = Math.min(totalCount - 1, Math.floor(paid / installment));
  const nextDueDate = addMonthsClamped(input.firstDueDate, completedInstallments);
  const currentInstallmentTotal = completedInstallments === totalCount - 1
    ? starting - installment * (totalCount - 1)
    : installment;
  const paidIntoCurrent = paid - completedInstallments * installment;
  const nextDueAmountMinor = Math.min(
    remaining,
    Math.max(0, currentInstallmentTotal - paidIntoCurrent),
  );

  return {
    currentOpeningDueMinor: currentOpening,
    paidSinceStartMinor: paid,
    arrangementRemainingMinor: remaining,
    suggestedMinor: suggested,
    overdueMinor,
    nextDueDate,
    nextDueAmountMinor,
    completed: false,
  };
}
