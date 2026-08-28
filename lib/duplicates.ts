/**
 * كشف تكرار المرضى — المنطق الخالص.
 *
 * المبدأ الأول في الدستور: **مريض واحد لا خمسة**. وأشيع طريقة لكسره ليست خللًا
 * برمجيًا — هي أن تُنشئ الاستقبال سجلًا ثانيًا لمريض موجود لأنها لم تجده.
 *
 * وثمنه لا يظهر يوم الإنشاء بل بعد شهور: تاريخٌ سريري نصفه في ملف ونصفه في آخر،
 * ورصيدٌ منقسم فيبدو المريض غير مدين وهو مدين، وتذكيرٌ يصل مرتين. **ودمج ملفين بعد
 * أن يحمل كلٌّ منهما فواتير ودفعات عملٌ محاسبي لا زرّ**، ولهذا يُمنع الانقسام قبل
 * وقوعه لا يُعالَج بعده.
 *
 * والقاعدة: **تحذير لا منع**. لأن التوائم موجودة، والأسماء المتشابهة في اليمن كثيرة،
 * والأب وابنه قد يتشاركان رقمًا واحدًا. ونظامٌ يمنع الإنشاء يعلّم الاستقبال أن
 * تحتال عليه — بإضافة نقطة إلى الاسم — فيصير التكرار أخفى لا أقلّ.
 */

/** تطبيع الاسم للمقارنة: يُزال التشكيل والمدّ وتُوحّد الحروف المتشابهة والمسافات. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[ً-ْـ]/g, "")          // التشكيل والتطويل
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    // «عبد الله» و«عبدالله» اسمٌ واحد. ويُوحَّد في **التطبيع** لا في التقطيع وحده،
    // وإلا فاتت المطابقة التامة وسقط الاسم إلى «قريب جدًا» — إشارةٌ أضعف مما يستحق.
    .replace(/عبد\s+/g, "عبد")
    .toLowerCase();
}

/** كلمات الاسم بلا ألقاب — «عبدالله» و«عبد الله» يتساويان. */
export function nameTokens(raw: string): string[] {
  return normalizeName(raw)
    .split(" ")
    .filter((word) => word.length > 1);
}

/**
 * هل الرقمان لشخص واحد؟
 *
 * المقارنة الحرفية لا تكفي: الرقم يُخزَّن `967770245745` ويُكتب في الاستقبال
 * `770245745`، وأحيانًا `0770245745` أو `+967 770 245 745`. ومقارنةٌ حرفية تعتبرها
 * أربعة أشخاص — وهو بالضبط ما جاء هذا الملف ليمنعه.
 *
 * فتُقارَن **آخر تسع خانات**: طول الرقم اليمني المحلي. وأقلّ من سبع خانات يُقارن
 * حرفيًا: رقمٌ قصير قد يكون امتدادًا داخليًا، ومطابقة ذيله تجمع غرباء في ملف واحد.
 */
export function samePhone(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const digitsA = a.replace(/\D/g, "");
  const digitsB = b.replace(/\D/g, "");
  if (!digitsA || !digitsB) return false;
  if (digitsA.length < 7 || digitsB.length < 7) return digitsA === digitsB;
  return digitsA.slice(-9) === digitsB.slice(-9);
}

export interface CandidatePatient {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  altPhone: string | null;
  birthYear: number | null;
}

export type MatchReason = "phone" | "same_name" | "similar_name" | "name_and_age";

export const MATCH_LABEL: Record<MatchReason, string> = {
  phone: "نفس رقم الجوال",
  same_name: "نفس الاسم تمامًا",
  similar_name: "اسم قريب جدًا",
  name_and_age: "نفس الاسم وسنة الميلاد",
};

export interface DuplicateMatch {
  patient: CandidatePatient;
  reason: MatchReason;
  /** كلما ارتفعت زاد الاحتمال — للترتيب لا للحجب. */
  score: number;
}

/**
 * كم كلمة مشتركة بين اسمين، نسبةً إلى الأقصر.
 *
 * النسبة إلى **الأقصر** مقصودة: «محمد سالم» و«محمد سالم أحمد الحكيمي» شخصٌ واحد
 * غالبًا كُتب اسمه مرة مختصرًا. والنسبة إلى الأطول كانت ستخفضه إلى النصف فيمرّ.
 */
export function nameOverlap(a: string, b: string): number {
  const first = new Set(nameTokens(a));
  const second = nameTokens(b);
  if (first.size === 0 || second.length === 0) return 0;
  const shared = second.filter((word) => first.has(word)).length;
  return shared / Math.min(first.size, second.length);
}

/**
 * المطابقات المحتملة لمريض على وشك الإنشاء.
 *
 * الهاتف أقوى دليل فيتصدّر. ثم الاسم الكامل المطابق. ثم الاسم القريب. والاسم وحده
 * لا يكفي للترتيب الأعلى: «محمد أحمد» في تعز عشرات.
 */
export function findDuplicates(
  input: { fullName: string; phone: string | null; altPhone: string | null; birthYear: number | null },
  candidates: CandidatePatient[],
): DuplicateMatch[] {
  const phones = [input.phone, input.altPhone].filter((p): p is string => Boolean(p));
  const target = normalizeName(input.fullName);
  const matches: DuplicateMatch[] = [];

  for (const candidate of candidates) {
    const candidatePhones = [candidate.phone, candidate.altPhone].filter(Boolean) as string[];
    const phoneMatch = candidatePhones.some((stored) => phones.some((given) => samePhone(given, stored)));
    const sameName = normalizeName(candidate.fullName) === target;
    const overlap = nameOverlap(input.fullName, candidate.fullName);
    const sameYear =
      input.birthYear !== null && candidate.birthYear !== null && input.birthYear === candidate.birthYear;

    if (phoneMatch) {
      matches.push({ patient: candidate, reason: "phone", score: sameName ? 100 : 90 });
    } else if (sameName && sameYear) {
      matches.push({ patient: candidate, reason: "name_and_age", score: 80 });
    } else if (sameName) {
      matches.push({ patient: candidate, reason: "same_name", score: 60 });
    } else if (overlap >= 0.75) {
      matches.push({ patient: candidate, reason: "similar_name", score: Math.round(40 * overlap) });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** نصّ التحذير — يقترح ولا يقرّر. */
export function duplicateWarning(matches: DuplicateMatch[]): string {
  if (matches.length === 0) return "";
  return matches.length === 1
    ? "يوجد مريض مسجّل قد يكون نفس الشخص. راجعه قبل الإضافة."
    : `يوجد ${matches.length} مرضى مسجّلين قد يكون أحدهم نفس الشخص. راجعهم قبل الإضافة.`;
}
