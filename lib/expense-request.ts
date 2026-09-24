import { isExpenseCategory, type ExpenseCategory } from "./expenses";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import { rateOf, type RateMap } from "./supplier-payments";

/**
 * (P0-2) قراءة طلب سند الصرف — مشتركة بين التسجيل (/api/expenses) والمعاينة
 * (/api/expenses/quote) فلا تعاين الشاشة شيئًا ثم يُسجَّل غيره.
 *
 * أسعار الصرف من الإعدادات دائمًا. والمدير وحده يقرّ سعرًا يخالفها (سعر عملة
 * الدفع و/أو سعر عملة الفاتورة، كلاهما «كم ريالًا يمنيًا للوحدة») ومعه سببٌ
 * مكتوب يُحفظ في السند ويُدقَّق. والدفعة المقدمة فوق رصيد المورد للمدير وحده بسبب.
 */
export interface ParsedExpenseRequest {
  category: ExpenseCategory;
  partyId: number | null;
  payeeText: string | null;
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  payableId: number | null;
  payableExchangeRate: number | null;
  rateOverrideReason: string | null;
  prepaymentReason: string | null;
  note: string | null;
  /** سعر الإعدادات لعملة الدفع — للتدقيق حين يُقَرّ غيره. */
  settingsExchangeRate: number | null;
}

export type ParseResult =
  | { ok: true; value: ParsedExpenseRequest }
  | { ok: false; status: number; message: string };

const MAX_RATE = 1_000_000;

function readRate(raw: unknown): number | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null;
  const rate = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE) return "invalid";
  return Math.round(rate * 1_000_000) / 1_000_000;
}

export function parseExpenseRequest(
  source: Record<string, unknown>,
  settingsRates: RateMap,
  isAdmin: boolean,
): ParseResult {
  if (!isExpenseCategory(source.category)) {
    return { ok: false, status: 400, message: "اختر تصنيف المصروف." };
  }
  const currency = source.currency;
  if (!isCurrency(currency)) return { ok: false, status: 400, message: "اختر العملة." };
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor <= 0) {
    return { ok: false, status: 400, message: "اكتب مبلغًا أكبر من صفر." };
  }

  const partyIdRaw = Number(source.partyId);
  const partyId = Number.isInteger(partyIdRaw) && partyIdRaw > 0 ? partyIdRaw : null;
  const payeeText = typeof source.payee === "string" && source.payee.trim()
    ? source.payee.trim().slice(0, 120) : null;
  const payableIdRaw = Number(source.payableId);
  const payableId = Number.isInteger(payableIdRaw) && payableIdRaw > 0 ? payableIdRaw : null;
  // جهة أو اسم مكتوب أو التزام — أحدها على الأقل: سند صرف بلا مستفيد ورقةٌ لا تُراجَع.
  if (!partyId && !payeeText && !payableId) {
    return { ok: false, status: 400, message: "اكتب جهة الصرف أو اخترها من القائمة." };
  }
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  const settingsExchangeRate = rateOf(currency, settingsRates);
  const overrideRate = readRate(source.exchangeRate);
  const overrideBillRate = readRate(source.payableExchangeRate);
  if (overrideRate === "invalid" || overrideBillRate === "invalid") {
    return { ok: false, status: 400, message: "سعر الصرف المُدخل غير صالح — رقمٌ أكبر من صفر." };
  }
  const rateOverrideReason = typeof source.rateOverrideReason === "string" && source.rateOverrideReason.trim()
    ? source.rateOverrideReason.trim().slice(0, 300) : null;
  const paymentRateOverridden = currency !== CLINIC_BASE_CURRENCY
    && overrideRate !== null && overrideRate !== settingsExchangeRate;
  const billRateOverridden = overrideBillRate !== null;
  if (paymentRateOverridden || billRateOverridden) {
    if (!isAdmin) {
      return { ok: false, status: 403, message: "تعديل سعر الصرف عن سعر الإعدادات للمدير وحده." };
    }
    if (!rateOverrideReason || rateOverrideReason.length < 3) {
      return { ok: false, status: 400, message: "اكتب سبب اختلاف سعر الصرف عن سعر الإعدادات — يُحفظ في السند ويُدقَّق." };
    }
  }
  const exchangeRate = paymentRateOverridden ? (overrideRate as number) : settingsExchangeRate;
  if (exchangeRate === null) {
    return { ok: false, status: 409, message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل الصرف بعملة أجنبية." };
  }

  const prepayment = source.prepayment === true;
  const prepaymentReason = typeof source.prepaymentReason === "string" && source.prepaymentReason.trim()
    ? source.prepaymentReason.trim().slice(0, 300) : null;
  if (prepayment) {
    if (!isAdmin) {
      return { ok: false, status: 403, message: "الدفعة المقدمة فوق رصيد المورد للمدير وحده." };
    }
    if (!prepaymentReason || prepaymentReason.length < 3) {
      return { ok: false, status: 400, message: "اكتب سبب الدفعة المقدمة — يُحفظ في السند ويُدقَّق." };
    }
  }

  return {
    ok: true,
    value: {
      category: source.category, partyId, payeeText, amountMinor, currency, exchangeRate, payableId,
      payableExchangeRate: billRateOverridden ? (overrideBillRate as number) : null,
      rateOverrideReason: paymentRateOverridden || billRateOverridden ? rateOverrideReason : null,
      prepaymentReason: prepayment ? prepaymentReason : null,
      note, settingsExchangeRate,
    },
  };
}

/** حالة HTTP لكل رفض — والرسالة العربية من refusalMessage. */
export function refusalStatus(reason: string): number {
  if (reason === "party_not_found" || reason === "payable_not_found") return 404;
  if (reason === "zero_settlement") return 400;
  return 409;
}
