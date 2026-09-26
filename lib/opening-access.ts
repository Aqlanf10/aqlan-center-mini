/**
 * (DAY1 — قرار المالك) من يسجّل الرصيد السابق (الافتتاحي) للمرضى القدامى:
 * المدير يضيف ويعدّل ويحذف؛ والاستقبال — إن فعّله الإعداد — يضيف رصيدًا لعملةٍ لا رصيد
 * للمريض بها بعد، ولا يعدّل ولا يحذف (التعديل يمسّ دَينًا ظهر في كشوف، فيبقى للمدير بسبب).
 */
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";

export interface OpeningAccess {
  add: boolean;
  edit: boolean;
}

export function openingBalanceAccess(role: string | null | undefined, receptionAllowed: boolean): OpeningAccess {
  if (role === "admin") return { add: true, edit: true };
  if (role === "reception" && receptionAllowed) return { add: true, edit: false };
  return { add: false, edit: false };
}

export interface OpeningInput {
  currency: Currency;
  amountMinor: number;
  asOfDate: string;
  note: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** مبلغ الرصيد السابق وعملته وتاريخه وملاحظته من الطلب — برسالة عربية لأول خطأ. */
export function parseOpeningInput(source: Record<string, unknown>, today: string):
  | { ok: true; value: OpeningInput }
  | { ok: false; message: string } {
  const currency = source.currency === undefined || source.currency === null || source.currency === ""
    ? CLINIC_BASE_CURRENCY : source.currency;
  if (!isCurrency(currency)) return { ok: false, message: "عملة الرصيد غير صالحة." };
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor <= 0) {
    return { ok: false, message: "اكتب المبلغ الذي كان على المريض قبل بدء النظام." };
  }
  const asOfDate = typeof source.asOfDate === "string" && DATE_PATTERN.test(source.asOfDate) ? source.asOfDate : today;
  if (asOfDate > today) return { ok: false, message: "تاريخ الرصيد الافتتاحي لا يكون في المستقبل." };
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  return { ok: true, value: { currency, amountMinor, asOfDate, note } };
}
