import { CURRENCIES, type Currency } from "./money";
import { INVOICE_CURRENCY_SCOPE_MESSAGES } from "./invoice-currency-scope";
import type { InvoiceRevisionView } from "./invoice-revision-view";

export interface InvoiceCurrencyReadiness {
  currency: Currency;
  status: "current" | "eligible" | "unsupported" | "review" | "unverified";
  selectable: boolean;
  message: string;
}

/** Presentation of the existing validated preview only, never write authority.
 * Do not infer eligibility from a translated message or a missing response. */
export function invoiceCurrencyReadiness(input: {
  sourceCurrency?: Currency;
  preview: "ready" | "loading" | "unavailable" | "recovery";
  correction?: InvoiceRevisionView["currencyCorrection"];
}): InvoiceCurrencyReadiness[] {
  return CURRENCIES.map(currency => {
    if (input.preview !== "ready" || !input.sourceCurrency) return {
      currency, status: "unverified", selectable: false,
      message: input.preview === "loading" ? "جارٍ التحقق من خيارات التصحيح."
        : input.preview === "recovery" ? "اختيار العملة متوقف حتى حسم طلب التصحيح المحفوظ."
        : "تعذّر التحقق من إتاحة التصحيح؛ أعد قراءة الفاتورة.",
    };
    if (currency === input.sourceCurrency) return {
      currency, status: "current", selectable: true, message: "عملة الفاتورة الحالية؛ لا تغيير للعملة.",
    };
    const proof = input.correction;
    if (!proof || !Array.isArray(proof.targets)) return {
      currency, status: "unverified", selectable: false, message: "لم يكتمل إثبات إتاحة تصحيح العملة؛ أعد قراءة الفاتورة.",
    };
    // Contradictory or refused proof fails closed before any target is considered.
    if (proof.available && !proof.reasonCodes?.length && proof.targets.includes(currency)) return {
      currency, status: "eligible", selectable: true,
      message: input.sourceCurrency === "YER" && currency === "SAR"
        ? "متاح وفق المعاينة الحالية، مع إعادة التحقق عند التأكيد."
        : "متاح لأن الفاتورة بلا سندات؛ اكتب أسعار البنود بهذه العملة. لا تحويل بسعر صرف، ويُعاد التحقق عند التأكيد.",
    };
    if (proof.available && !proof.reasonCodes?.length) return {
      currency, status: "unsupported", selectable: false,
      message: "هذا الاتجاه متاح فقط لفاتورة لم يُسجَّل عليها أي سند؛ لا يمكن تأكيده لهذه الفاتورة.",
    };
    return {
      currency, status: "review", selectable: false,
      message: proof.reasonCodes?.length
        ? proof.reasonCodes.map(reason => INVOICE_CURRENCY_SCOPE_MESSAGES[reason]).join(" ")
        : proof.message.trim() || "إثبات التسوية أو ارتباط الفاتورة يحتاج مراجعة؛ لم تتغيّر البيانات.",
    };
  });
}
