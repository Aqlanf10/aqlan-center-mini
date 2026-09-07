/**
 * الوصفة الطبية — الروشتة التي يخرج بها المريض إلى الصيدلية.
 * (منقولة من مستودع الوكيل الآخر aqlan-center-main ومكيّفة لطباعتنا الحالية.)
 *
 * وهي **وثيقة**، لا شاشةٌ تُملأ ثم تُطبع: يحملها المريض إلى صيدليٍّ يصرف بها
 * دواءً، ويرجع إليها الطبيب بعد شهرٍ ليعرف بماذا عالج، وقد تُطلب في نزاع. فما
 * يُطبع منها يجب أن يكون **محفوظًا كما طُبع**، ومنسوبًا إلى من أصدره، وبتاريخه.
 *
 * وثلاثةٌ تُحرَس هنا:
 *
 * ١) **لا تُختلق وصفة.** صفحةٌ تُفتح بلا محتوى لا تطبع دواءً «مثالًا»: ورقةٌ
 *    عليها ترويسة المركز واسم الطبيب وأدويةٌ لم يصفها أحد وصفةٌ حقيقية في يد
 *    من يحملها، ويصرفها الصيدليّ.
 *
 * ٢) **لا تُعدَّل بعد إصدارها.** المريض خرج بنسخته، فتعديل المحفوظ يجعل نسخته
 *    ونسخة الملف تقولان شيئين. والخطأ يُصحَّح بإبطالٍ مُعلَّلٍ ووصفةٍ جديدة —
 *    فيبقى في السجل أنّ الأولى كانت وأنّها أُبطلت ولماذا.
 *
 * ٣) **أسماء الأدوية بالإنجليزية.** هي لغة العلب والصيدليات في اليمن، ونقلُها
 *    إلى العربية يُنتج اسمًا لا يجده الصيدليّ. أمّا تعليمات المريض فبلغته.
 *
 * نظامنا كان يطبع الوصفة من معاملات الرابط وحده — وثيقةٌ تُفقد بمرور الجلسة.
 * هذه الوحدة تجعلها سجلًا محفوظًا مع إبطالٍ موثّق واقتراحات مما سبق وصفه.
 */

export type InstructionsLang = "both" | "ar" | "en";

export function isInstructionsLang(value: unknown): value is InstructionsLang {
  return value === "both" || value === "ar" || value === "en";
}

export const INSTRUCTIONS_LANG_LABEL: Record<InstructionsLang, string> = {
  both: "بالعربية والإنجليزية",
  ar: "بالعربية",
  en: "بالإنجليزية",
};

/** دواءٌ واحد في الوصفة. */
export interface RxItem {
  /** الاسم كما يُكتب على العلبة — إنجليزيًّا. */
  name: string;
  /** العيار: `500mg` · `1g` — نصٌّ لأنّ الوحدات تختلف. */
  dose: string;
  /** الشكل: أقراص، كبسولات، شراب، غسول، مرهم. */
  form: string;
  /** التكرار: `1 tablet every 8 hours`. */
  frequency: string;
  /** المدّة: `5 days`. */
  duration: string;
  /** تعليمات المريض بالعربية. */
  instructions: string;
  /** وبالإنجليزية. */
  instructionsEn: string;
}

/** حدودٌ تمنع حقلًا واحدًا من أن يبتلع الوثيقة. */
export const MAX_ITEMS = 20;
export const MAX_FIELD = 200;
export const MAX_TEXT = 2000;
/** أقصر سببٍ يُقبل للإبطال — «خطأ» وحدها لا تقول شيئًا لمن يقرأ السجل بعد سنة. */
export const MIN_VOID_REASON = 6;

const text = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

/**
 * أفيه حرفٌ لاتينيّ؟
 *
 * فاسم الدواء يُكتب كما على العلبة — والصيدليّ يبحث عن `Amoxicillin` لا عن
 * «أموكسيسيلين»، والمكتوب بالعربية وحدها لا يجده في رفّه ولا في نظامه. أمّا
 * التعليمات فبالعربية، وهي موضعُها.
 *
 * وحرفٌ واحد يكفي: أسماءٌ كثيرة تحمل أرقامًا ونسبًا ورموزًا (`Chlorhexidine
 * 0.12%`)، واشتراط اللاتينية الخالصة يردّ اسمًا صحيحًا.
 */
export const hasLatin = (value: string): boolean => /[A-Za-z]/.test(value);

/**
 * دواءٌ من مُدخلٍ غير موثوق.
 *
 * ويعيد `null` لما لا اسم له: سطرٌ فيه جرعةٌ بلا دواء ليس دواءً ناقصًا بل سطرٌ
 * فارغ تركه من يملأ النموذج. وحفظُه يطبع «(500mg)» وحدها في الروشتة.
 */
export function sanitizeRxItem(input: unknown): RxItem | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const name = text(source.name, MAX_FIELD);
  if (!name || !hasLatin(name)) return null;
  return {
    name,
    dose: text(source.dose, MAX_FIELD),
    form: text(source.form, MAX_FIELD),
    frequency: text(source.frequency, MAX_FIELD),
    duration: text(source.duration, MAX_FIELD),
    instructions: text(source.instructions, MAX_TEXT),
    instructionsEn: text(source.instructionsEn, MAX_TEXT),
  };
}

export function sanitizeRxItems(input: unknown): RxItem[] {
  if (!Array.isArray(input)) return [];
  const items: RxItem[] = [];
  for (const raw of input) {
    const item = sanitizeRxItem(raw);
    if (item) items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export interface PrescriptionDraft {
  patientId: number;
  visitId: number | null;
  diagnosis: string;
  notes: string;
  instructionsLang: InstructionsLang;
  items: RxItem[];
}

export type DraftCheck =
  | { ok: true; value: PrescriptionDraft }
  | { ok: false; message: string };

/**
 * يفحص مسوّدة الوصفة قبل أن تصير وثيقة.
 *
 * والبطلان بأسبابٍ مصرّحة لا برسائل غامضة: الطبيب الذي فرغ من كتابة روشتةٍ
 * كاملة يحتاج أن يعرف **ماذا** نقص لا أن يُقال له «طلب غير صالح».
 */
export function checkPrescriptionDraft(input: {
  patientId: number;
  visitId: number | null;
  diagnosis: unknown;
  notes: unknown;
  instructionsLang: unknown;
  items: unknown;
}): DraftCheck {
  if (!Number.isInteger(input.patientId) || input.patientId <= 0) {
    return { ok: false, message: "رقم الملف غير صالح للوصفة." };
  }
  if (input.visitId !== null && !(Number.isInteger(input.visitId) && input.visitId > 0)) {
    return { ok: false, message: "رقم الزيارة غير صالح." };
  }
  const items = sanitizeRxItems(input.items);
  if (items.length === 0) {
    return { ok: false, message: "الوصفة بلا أدوية — أضف دواءً واحدًا على الأقل." };
  }
  const lang: InstructionsLang = isInstructionsLang(input.instructionsLang)
    ? input.instructionsLang : "both";
  return {
    ok: true,
    value: {
      patientId: input.patientId,
      visitId: input.visitId,
      diagnosis: text(input.diagnosis, MAX_TEXT),
      notes: text(input.notes, MAX_TEXT),
      instructionsLang: lang,
      items,
    },
  };
}

export interface VoidCheck {
  ok: boolean;
  reason: string;
}

/** سبب الإبطال: إلزاميّ وطويل بما يُقرأ. */
export function checkVoidReason(input: unknown): VoidCheck {
  const reason = text(input, MAX_TEXT);
  if (reason.length < MIN_VOID_REASON) {
    return { ok: false, reason: `اكتب سببًا للإبطال لا يقلّ عن ${MIN_VOID_REASON} أحرف — «خطأ» وحدها لا تُقرأ بعد سنة.` };
  }
  return { ok: true, reason };
}

/**
 * اقتراحات مما سبق وصفه — من وصفاتٍ موثّقة سابقة.
 *
 * تُرتّب بالأحدث أولًا ثم بالأكثر تكرارًا، وتُعرض للطبيب كرقائقٍ يقلّل بها
 * النقر. **ولا تُفرض**: التكرار الإداري المريح ليس قرارًا سريريًّا.
 */
export interface SuggestionItem {
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  timesPrescribed: number;
  lastPrescribedAt: string;
}

export function buildSuggestions(
  history: readonly {
    items: RxItem[]; createdAt: string;
  }[],
  limit = 8,
): SuggestionItem[] {
  const byName = new Map<string, { item: RxItem; count: number; lastAt: string }>();
  for (const prescription of history) {
    for (const item of prescription.items) {
      const key = item.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing || prescription.createdAt > existing.lastAt) {
        byName.set(key, {
          item,
          count: (existing?.count ?? 0) + 1,
          lastAt: prescription.createdAt,
        });
      } else {
        existing.count += 1;
      }
    }
  }
  return [...byName.values()]
    .sort((one, two) =>
      two.lastAt.localeCompare(one.lastAt) || two.count - one.count)
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      name: entry.item.name,
      dose: entry.item.dose,
      frequency: entry.item.frequency,
      duration: entry.item.duration,
      timesPrescribed: entry.count,
      lastPrescribedAt: entry.lastAt,
    }));
}
