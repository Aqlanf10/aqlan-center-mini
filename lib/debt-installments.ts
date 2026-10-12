/** A repayment schedule allocates debt already posted by an invoice or opening
 * balance. It is never a bill, treatment valuation, receipt, or payment promise
 * marked as collected. All amounts are minor units of the debt's currency. */
export interface DebtInstallment {
  dueDate: string;
  amountMinor: number;
  kind: "down_payment" | "installment";
}
export type DebtRepaymentTerms =
  | { mode: "full"; installments: [] }
  | { mode: "installments"; installments: DebtInstallment[] };

function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}

export function validateDebtRepaymentTerms(value: unknown, remainingMinor: number):
  | { ok: true; value: DebtRepaymentTerms }
  | { ok: false; message: string } {
  if (!Number.isSafeInteger(remainingMinor) || remainingMinor < 0) return { ok: false, message: "تعذّر التحقق من الدين المتبقي بعملته." };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "اختر طريقة السداد." };
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !["mode", "installments"].includes(key))) return { ok: false, message: "بيانات جدول السداد غير صالحة." };
  if (source.mode === "full" && Array.isArray(source.installments) && source.installments.length === 0) {
    return { ok: true, value: { mode: "full", installments: [] } };
  }
  if (source.mode !== "installments" || !Array.isArray(source.installments) || source.installments.length < 1 || source.installments.length > 60 || remainingMinor === 0) {
    return { ok: false, message: "أضف من قسط واحد إلى ٦٠ قسطًا لدين قائم." };
  }
  const installments: DebtInstallment[] = [];
  let total = 0;
  for (const raw of source.installments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).some(key => !["dueDate", "amountMinor", "kind"].includes(key))) return { ok: false, message: "بيانات القسط غير صالحة." };
    const row = raw as Record<string, unknown>;
    if (!date(row.dueDate) || typeof row.amountMinor !== "number" || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0
      || row.kind !== "down_payment" && row.kind !== "installment") return { ok: false, message: "كل قسط يحتاج تاريخًا صحيحًا ومبلغًا موجبًا بعملة الدين." };
    if (row.kind === "down_payment" && installments.length !== 0) return { ok: false, message: "الدفعة المقدمة موعد واحد في بداية الجدول؛ ليست مبلغًا محصّلًا." };
    if (installments.length && row.dueDate < installments[installments.length - 1].dueDate) return { ok: false, message: "رتّب تواريخ الأقساط من الأقدم إلى الأحدث." };
    total += row.amountMinor;
    if (!Number.isSafeInteger(total)) return { ok: false, message: "مجموع الأقساط خارج النطاق الآمن." };
    installments.push({ dueDate: row.dueDate, amountMinor: row.amountMinor, kind: row.kind });
  }
  if (total !== remainingMinor) return { ok: false, message: "مجموع الدفعة المقدمة والأقساط يجب أن يساوي الدين المتبقي، بعد طرح التحصيل المثبت مرة واحدة." };
  return { ok: true, value: { mode: "installments", installments } };
}

/** Revisions snapshot remaining debt. The canonical receipt writer supplies net
 * settlement since that snapshot, including refunds at their recorded FX.
 * A debt correction must never masquerade as collected cash. */
export function debtInstallmentProgress(input: {
  principalMinor: number; currentRemainingMinor: number; netSettledSinceRevisionMinor: number;
  installments: readonly DebtInstallment[]; today: string;
}) {
  const { principalMinor, currentRemainingMinor, netSettledSinceRevisionMinor, installments, today } = input;
  if (![principalMinor,currentRemainingMinor,netSettledSinceRevisionMinor].every(Number.isSafeInteger)
    || principalMinor < 0 || currentRemainingMinor < 0 || !date(today)
    || !validateDebtRepaymentTerms({ mode: "installments", installments },principalMinor).ok) throw new Error("Invalid debt position");
  const settledSinceRevisionMinor = Math.max(0, Math.min(principalMinor,netSettledSinceRevisionMinor));
  let paid = settledSinceRevisionMinor;
  let overdueMinor = 0;
  const rows = installments.map(row => {
    const settledMinor = Math.min(row.amountMinor, paid); paid -= settledMinor;
    const remainingMinor = row.amountMinor - settledMinor;
    if (row.dueDate < today) overdueMinor += remainingMinor;
    return { ...row, settledMinor, remainingMinor };
  });
  const allocatedRemainingMinor = principalMinor - settledSinceRevisionMinor;
  return { rows, overdueMinor, unallocatedMinor: Math.max(0, currentRemainingMinor - allocatedRemainingMinor),
    requiresRevision: currentRemainingMinor !== allocatedRemainingMinor,
    settledSinceRevisionMinor,
    currentRemainingMinor, next: rows.find(row => row.remainingMinor > 0) ?? null };
}
