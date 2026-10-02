import { CASH_ACCOUNT } from "./accounting";

const PHYSICAL_CASH_CODES = new Set(Object.values(CASH_ACCOUNT));

/** Classification is deliberately by account code, not date, side or net.
 * A mismatched supplied currency cannot turn a cash account into a safe bypass. */
export function hasManualCashLine(lines: ReadonlyArray<{ accountCode: string }>): boolean {
  return lines.some((line) => PHYSICAL_CASH_CODES.has(line.accountCode));
}

export const MANUAL_CASH_ENTRY_GUIDANCE =
  "حماية مؤقتة: تُمنع القيود اليدوية على حسابات الصندوق أثناء أي وردية مفتوحة، حتى تصحيحات الفترات السابقة والأرصدة الافتتاحية. استخدم مستند القبض أو الرد أو الصرف المناسب؛ حركات رأس المال والتحويل تحتاج مسارًا مرتبطًا بالوردية.";

export type ManualCashEntryConflictCode =
  | "manual_cash_requires_linked_movement"
  | "manual_cash_shift_busy";

export class ManualCashEntryConflictError extends Error {
  readonly code: ManualCashEntryConflictCode;

  constructor(code: ManualCashEntryConflictCode = "manual_cash_requires_linked_movement") {
    super(code === "manual_cash_shift_busy"
      ? "تعذّر تأكيد حالة الصندوق لأنه مشغول الآن. لم يُحفظ القيد؛ انتظر قليلًا ثم أعد المحاولة."
      : MANUAL_CASH_ENTRY_GUIDANCE);
    this.name = "ManualCashEntryConflictError";
    this.code = code;
  }
}
