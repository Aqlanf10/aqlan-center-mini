/**
 * الاستدعاء ومتابعة المتغيّبين — المنطق الخالص.
 *
 * سبب وجود هذه الوحدة بكلمات المالك: «بدي تتشوه سمعتنا أنه ما في أي اهتمام ولا
 * تواصل». وهذه ليست مشكلة برمجية — إنها مكالمة لم تُجرَ. المريض الذي لم يحضر موعده
 * ولم يتصل به أحد يفهم أن العيادة لم تلاحظ غيابه؛ ومريض التقويم الذي انقطع شهرين
 * يظن أن علاجه انتهى، ثم يعود وقد تأخّر، ثم يحكي للناس.
 *
 * القاعدة التي تحكم هذه الوحدة: **لا يُتصل بأحد مرتين، ولا يُنسى أحد**. لذلك تُسجَّل
 * كل متابعة، ويعود المريض إلى القائمة إن بقي منقطعًا بعد مدة.
 */

export type RecallReason = "missed" | "lapsed";

export interface RecallRow {
  kind: RecallReason;
  /** مُعرّف الموعد للمتغيّب، ومُعرّف المريض للمنقطع. */
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  /** تاريخ الموعد الفائت، أو تاريخ آخر نشاط للمنقطع. */
  referenceDate: string;
  note: string | null;
}

/** كم أسبوعًا يمرّ قبل أن يُعدّ المريض منقطعًا. دورة متابعة التقويم أربعة أسابيع. */
export const LAPSE_OPTIONS = [6, 12, 24] as const;
export type LapseWeeks = (typeof LAPSE_OPTIONS)[number];

export const LAPSE_LABEL: Record<LapseWeeks, string> = {
  6: "أكثر من ٦ أسابيع",
  12: "أكثر من ٣ أشهر",
  24: "أكثر من ٦ أشهر",
};

/**
 * الأسابيع منذ تاريخ، وأدناها صفر.
 *
 * التقريب لأسفل لا للأقرب: «مضى ٥ أسابيع» عن أربعة أسابيع وستة أيام أدقّ في القراءة
 * السريعة من «٦ أسابيع» عن مدة لم تكتمل.
 */
export function weeksSince(date: string, today: string): number {
  const then = Date.parse(`${date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.floor((now - then) / (7 * 86_400_000)));
}

/**
 * «منذ ٥ أسابيع» / «منذ ٣ أشهر» — بالوحدة التي ينطقها الناس لا بالأيام.
 *
 * الواحد والاثنان بلا رقم: العربية تقول «منذ أسبوع» و«منذ أسبوعين» لا «منذ 1 أسبوع».
 * والرسالة تُقرأ على المريض نفسه في واتساب، فعربية مكسورة فيها تُقرأ كإهمال آخر.
 */
export function sinceText(date: string, today: string): string {
  const weeks = weeksSince(date, today);
  if (weeks < 1) return "هذا الأسبوع";
  if (weeks < 9) {
    if (weeks === 1) return "منذ أسبوع";
    if (weeks === 2) return "منذ أسبوعين";
    return `منذ ${weeks} أسابيع`;
  }
  const months = Math.floor(weeks / 4);
  if (months === 1) return "منذ شهر";
  if (months === 2) return "منذ شهرين";
  return months <= 10 ? `منذ ${months} أشهر` : `منذ ${months} شهرًا`;
}

/**
 * رسالة استدعاء المنقطع.
 *
 * لا تلوم ولا تسأل «لماذا لم تأتِ»: اللوم يفقدك المريض نهائيًا، وهو أصلًا يعرف أنه
 * تأخّر. الرسالة تقول إننا لاحظنا — وهذا بالضبط ما يشكو المرضى من غيابه — ثم تفتح
 * بابًا سهلًا للعودة.
 */
export function recallText(input: {
  patientName: string;
  sinceText: string;
  clinicName: string;
  clinicPhone: string;
}): string {
  return [
    `السلام عليكم ${input.patientName}،`,
    ``,
    `نطمئن عليكم من ${input.clinicName}. لاحظنا أن آخر زيارة لكم كانت ${input.sinceText}،`,
    `ومتابعة العلاج في وقتها تختصر مدّته وتحفظ نتيجته.`,
    ``,
    `متى ما ناسبكم، أخبرونا لنحجز لكم موعدًا.`,
    `للتواصل: ${input.clinicPhone}`,
  ].join("\n");
}
