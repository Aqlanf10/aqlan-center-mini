/**
 * تسعير الأعمال دفعةً واحدة — **الخطوة التي تفصل المركز عن بدء التشغيل**.
 *
 * أُدخلت أعمال المركز الستّة والثمانون إلى قاعدة الإنتاج بلا أسعار (`price_configured`
 * زائفة)، و`validateProcedures` يرفض الخدمة غير المسعّرة، وشاشة الجاهزية تحجب البدء
 * ما لم توجد خدمةٌ مسعّرة واحدة. فالتسعير ليس تحسينًا — هو الباب.
 *
 * وتسعيرُها واحدةً واحدةً ستّةٌ وثمانون حفظًا وستّةٌ وثمانون ذهابًا وإيابًا. ومن يبدأ
 * ذلك يقف في المنتصف، فيبقى نصف الدليل مسعّرًا ونصفه لا — وهي أسوأ حالٍ من الاثنتين:
 * الشاشة تقول «جاهز» لأنّ فيها مسعّرًا، والاستقبال يصطدم بغير المسعّر عند الفوترة.
 *
 * **فالدفعة كلُّها أو لا شيء منها.** ورقمٌ خاطئ في السطر الأربعين يردّ الدفعة كلَّها
 * باسم صاحبه — لا يحفظ تسعةً وثلاثين ويسكت عن الأربعين.
 */

export interface PriceEntry {
  id: number;
  /** ما كُتب كما كُتب — يُحلَّل هنا لا في الشاشة. */
  price: string;
}

export type PriceBatch =
  | { ok: true; prices: { id: number; priceMinor: number }[] }
  | { ok: false; message: string };

/**
 * يقرأ الدفعة ويردّها كاملةً عند أوّل خطأ.
 *
 * و`parse` تُمرَّر من الخارج لأنّ تحويل المبلغ يتبع العملة الأساسية، وهي في
 * الإعدادات لا في هذا الملف — وحسابٌ ثانٍ للوحدة الصغرى هنا يفترق عن الأوّل.
 */
export function readPriceBatch(
  entries: readonly unknown[],
  parse: (input: string) => number | null,
  nameOf: (id: number) => string | null,
  max = 500,
): PriceBatch {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, message: "لا أسعار في الطلب." };
  }
  if (entries.length > max) {
    return { ok: false, message: `لا تُرسل أكثر من ${max} سعرًا في الدفعة الواحدة.` };
  }

  const prices: { id: number; priceMinor: number }[] = [];
  const seen = new Set<number>();

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const id = Number(entry.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, message: "رقم خدمةٍ غير صالح في الدفعة." };
    }
    // وخدمةٌ مرّتين في دفعةٍ واحدة: أيُّ السعرين يُحفظ؟ فتُردّ ولا يُخمَّن.
    if (seen.has(id)) {
      return { ok: false, message: `«${nameOf(id) ?? id}» مكرّرةٌ في الدفعة بسعرين.` };
    }
    seen.add(id);

    const priceMinor = parse(typeof entry.price === "string" ? entry.price : String(entry.price ?? ""));
    if (priceMinor === null) {
      return { ok: false, message: `سعر «${nameOf(id) ?? id}» غير صالح.` };
    }
    // وصفرٌ ليس سعرًا: خدمةٌ بصفرٍ تُفوتر بلا مقابل، ولا يُعرف أمجّانيةٌ هي أم منسيّة.
    if (priceMinor <= 0) {
      return { ok: false, message: `سعر «${nameOf(id) ?? id}» يجب أن يكون أكبر من صفر.` };
    }
    prices.push({ id, priceMinor });
  }
  return { ok: true, prices };
}
