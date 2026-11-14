import { ACCOUNT_BY_CODE } from "./accounting";
import { parseAmount, type Currency } from "./money";

/**
 * The payment split of an expense request (docs/finance/EXPENSE_COMMANDS_0128.md §2.2; owner #483
 * 6831365228 item 2). `ownerPrivateAmount` is the part the owner paid from a private source, in the
 * voucher currency; the rest left the drawer. A request without it is paid wholly from the drawer.
 *
 * Shape only: whether the caller may record a private part (the protected owner) and where it is posted
 * (the configured funding account) are decided by the server command, never by this parser.
 */
export const OWNER_PRIVATE_REASON_MIN = 3;
export const OWNER_PRIVATE_REASON_MAX = 300;

export interface ParsedPaymentSplit {
  drawerMinor: number;
  ownerPrivateMinor: number;
  ownerPrivateReason: string | null;
}
export type PaymentSplitParse = { ok: true; value: ParsedPaymentSplit } | { ok: false; message: string };

const present = (value: unknown) => value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");

/** True when the request asks for any private part at all (used to refuse it before parsing where it is not allowed). */
export function requestsOwnerPrivatePart(source: Record<string, unknown>): boolean {
  return present(source.ownerPrivateAmount) || present(source.ownerPrivateReason);
}

export function parseExpensePaymentSplit(source: Record<string, unknown>, amountMinor: number, currency: Currency): PaymentSplitParse {
  if (!present(source.ownerPrivateAmount)) {
    if (present(source.ownerPrivateReason)) {
      return { ok: false, message: "سبب الدفع من المصدر الخاص يُرسل فقط مع مبلغه؛ لم يُسجَّل شيء." };
    }
    return { ok: true, value: { drawerMinor: amountMinor, ownerPrivateMinor: 0, ownerPrivateReason: null } };
  }
  const privateMinor = parseAmount(String(source.ownerPrivateAmount), currency);
  if (privateMinor === null || privateMinor <= 0) {
    return { ok: false, message: "المبلغ المدفوع من المصدر الخاص رقم أكبر من صفر؛ لم يُسجَّل شيء." };
  }
  if (privateMinor > amountMinor) {
    return { ok: false, message: "المبلغ المدفوع من المصدر الخاص أكبر من مبلغ السند؛ لم يُسجَّل شيء." };
  }
  const reason = typeof source.ownerPrivateReason === "string" ? source.ownerPrivateReason.trim() : "";
  if (reason.length < OWNER_PRIVATE_REASON_MIN || reason.length > OWNER_PRIVATE_REASON_MAX) {
    return { ok: false, message: `اكتب سبب الدفع من المصدر الخاص (${OWNER_PRIVATE_REASON_MIN}–${OWNER_PRIVATE_REASON_MAX} حرفًا) — يُحفظ في السند والتدقيق؛ لم يُسجَّل شيء.` };
  }
  return { ok: true, value: { drawerMinor: amountMinor - privateMinor, ownerPrivateMinor: privateMinor, ownerPrivateReason: reason } };
}

/**
 * The configured account for private parts (`finance.owner_private_funding_account`). Empty means not
 * decided: no private part may be recorded. Only an existing postable equity or liability account is
 * accepted; cash, bank, expense, revenue and receivable accounts are refused, because crediting them would
 * invent cash or income. Returns the problem in Arabic, or null when the code is usable.
 */
export function ownerFundingAccountProblem(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return "لم يُحدَّد بعدُ حساب قيد ما يدفعه المالك من مصدره الخاص.";
  const account = ACCOUNT_BY_CODE.get(trimmed);
  if (!account || trimmed.length < 4) return "حساب تمويل المالك غير موجود في دليل الحسابات أو ليس حسابًا تفصيليًا.";
  if (account.kind !== "equity" && account.kind !== "liability") {
    return "حساب تمويل المالك يجب أن يكون من حقوق الملكية أو الالتزامات، لا صندوقًا ولا مصروفًا.";
  }
  return null;
}
