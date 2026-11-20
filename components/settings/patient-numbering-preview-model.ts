/** Inert presentation contract. Not authorization, allocation, persistence or a settings API. */
export interface NumberingDisplaySnapshot { prefix: string; next: string; revision: string }
export interface NumberingPreviewInput { prefix: string; next: string; expectedRevision: string }
export type NumberingPreviewResult =
  | { ok: true; prefix: string; next: string; preview: string; expectedRevision: string }
  | { ok: false; reason: string };
export type NumberingPreviewProvider = (input: NumberingPreviewInput) => Promise<NumberingPreviewResult>;

/** Explicit UI-only conversion: one digit in, one ASCII digit out, no Number. */
export function normalizeNumberingFormDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, digit => String.fromCharCode(
    48 + digit.charCodeAt(0) - (digit.charCodeAt(0) <= 0x0669 ? 0x0660 : 0x06f0),
  ));
}

/** Mirrors the source-only service grammar without converting identifiers to Number. */
export function numberingDraft(prefix: string, next: string): { prefix: string; next: string; preview: string } | null {
  const letter = prefix.trim().toUpperCase(), digits = next.trim();
  if (!/^[A-Z]$/.test(letter) || !/^[1-9][0-9]{0,17}$/.test(digits)) return null;
  return { prefix: letter, next: digits, preview: `${letter}-${digits.padStart(5, "0")}` };
}
export function validNumberingSnapshot(snapshot: NumberingDisplaySnapshot): boolean {
  return numberingDraft(snapshot.prefix, snapshot.next) !== null && snapshot.revision.length > 0;
}
export function numberingPreviewProblem(reason: string): string {
  const messages: Record<string, string> = {
    "invalid-input": "أدخل حرفًا واحدًا من A إلى Z ورقمًا من 1 إلى 18 خانة بالأرقام 0–9، دون صفر في البداية.",
    "history-unverified": "لم تكتمل مراجعة أرقام هذه السلسلة. لا يمكن اعتماد المعاينة.",
    "stale-preview": "تغيّرت القيم أو نسخة الإعدادات. راجعها وأعد فحص المعاينة.",
    "would-reuse-or-rewind": "الرقم قد يعيد استخدام رقم سابق أو يرجع بالسلسلة إلى الخلف. اختر رقمًا آخر.",
    "owner-required": "هذا الإعداد خاص بمالك العيادة. واجهة المعاينة لا تثبت الصلاحية.",
    "owner-numbering-not-activated": "تغيير الترقيم غير مفعّل. هذه الواجهة لا تحفظ إعدادات.",
    "idempotency-conflict": "تعارض طلب سابق. أعد قراءة القيم قبل المتابعة.",
    "numbering-transaction-failed": "تعذّر فحص الطلب. لم يُحفظ أي تغيير من هذه الواجهة.",
  };
  return Object.hasOwn(messages, reason) ? messages[reason] : "تعذّر التحقق من المعاينة. لا تعتمد هذه القيم قبل إعادة الفحص.";
}
