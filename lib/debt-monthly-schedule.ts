import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function dateParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    ? [year, month, day] : null;
}

/** Use the original day each month: Jan31 → Feb28 → Mar31, without UTC/DST
 * or repeated-clamping drift. Dates outside the four-digit calendar refuse. */
export function monthlyDueDate(first: string, offset: number): string | null {
  const parts = dateParts(first);
  if (!parts || !Number.isSafeInteger(offset) || offset < 0) return null;
  const [year, month, day] = parts;
  const index = year * 12 + month - 1 + offset;
  if (!Number.isSafeInteger(index)) return null;
  const nextYear = Math.floor(index / 12), nextMonth = index % 12 + 1;
  if (nextYear > 9999) return null;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(day, daysInMonth(nextYear, nextMonth))).padStart(2, "0")}`;
}

/** Allocate only the caller's already-authoritative remaining debt. Proposed
 * downpayments are schedule rows, never cash or a second debt subtraction. */
export function generateMonthlyDebtSchedule(input: {
  remainingMinor: number; downPaymentMinor: number; downPaymentDate: string;
  monthCount: number; firstMonthlyDate: string;
}): { ok: true; terms: DebtRepaymentTerms } | { ok: false; message: string } {
  const { remainingMinor, downPaymentMinor, downPaymentDate, monthCount, firstMonthlyDate } = input;
  if (!Number.isSafeInteger(remainingMinor) || remainingMinor < 0
    || !Number.isSafeInteger(downPaymentMinor) || downPaymentMinor < 0 || downPaymentMinor > remainingMinor) {
    return { ok: false, message: "اكتب دفعة مقدمة مقترحة صحيحة لا تتجاوز الدين المتبقي." };
  }
  if (remainingMinor === 0) return { ok: true, terms: { mode: "full", installments: [] } };
  const installments: Extract<DebtRepaymentTerms, { mode: "installments" }>["installments"] = [];
  if (downPaymentMinor > 0) {
    if (!dateParts(downPaymentDate)) return { ok: false, message: "اختر تاريخًا صحيحًا للدفعة المقدمة المقترحة." };
    installments.push({ dueDate: downPaymentDate, amountMinor: downPaymentMinor, kind: "down_payment" });
  }
  const remainder = remainingMinor - downPaymentMinor;
  if (remainder > 0) {
    const maxMonths = 60 - installments.length;
    if (!Number.isSafeInteger(monthCount) || monthCount < 1 || monthCount > maxMonths) {
      return { ok: false, message: `اختر عدد أشهر صحيحًا من 1 إلى ${maxMonths}؛ الجدول لا يتجاوز 60 موعدًا مع المقدمة.` };
    }
    if (remainder < monthCount) return { ok: false, message: "المتبقي أصغر من عدد الأقساط؛ قلّل الأشهر حتى يكون كل قسط موجبًا." };
    if (!dateParts(firstMonthlyDate) || downPaymentMinor > 0 && firstMonthlyDate < downPaymentDate) {
      return { ok: false, message: "اختر أول موعد شهري صحيحًا لا يسبق الدفعة المقدمة المقترحة." };
    }
    const quotient = BigInt(remainder) / BigInt(monthCount), residual = BigInt(remainder) % BigInt(monthCount);
    for (let index = 0; index < monthCount; index++) {
      const dueDate = monthlyDueDate(firstMonthlyDate, index);
      if (!dueDate) return { ok: false, message: "مواعيد الأقساط تتجاوز نطاق التاريخ المدعوم." };
      installments.push({ dueDate, amountMinor: Number(quotient + (BigInt(index) < residual ? 1n : 0n)), kind: "installment" });
    }
  }
  const checked = validateDebtRepaymentTerms({ mode: "installments", installments }, remainingMinor);
  return checked.ok ? { ok: true, terms: checked.value } : checked;
}
