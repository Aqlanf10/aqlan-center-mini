import {
  APPLIANCE_LABEL, ARCHES_LABEL, PHASE_LABEL, SLOT_LABEL, daysBetween, isElasticClass,
  type Appliance, type Arches, type ElasticClass, type OrthoPhase, type SlotSize,
} from "./ortho";

/**
 * (CASE-1) الحالة التقويمية السابقة (قبل النظام) وجلسة التقويم داخل توقيع الزيارة — المنطق الخالص.
 *
 * مريضٌ بدأ تقويمه قبل البرنامج بسنة لا يُعاد تمثيل تاريخه: لا فواتير وهمية ولا زيارات وهمية.
 * تُسجَّل **لقطة** لحاله اليوم — السلكان، المرحلة، ما مضى وما بقي، المطاطات، الأهداف المتبقية، الطبيب
 * المسؤول، وكيف عومل المال قبل النظام — ثم يستمر العلاج والمال في مساراتهما القائمة (الرصيد
 * الافتتاحي، خطط الأقساط، فوترة الزيارة عند التوقيع).
 */

export const LEGACY_FINANCIAL_MODES = ["opening_balance", "prepaid_included", "per_session", "installments"] as const;
export type LegacyFinancialMode = typeof LEGACY_FINANCIAL_MODES[number];

export const LEGACY_FINANCIAL_LABEL: Record<LegacyFinancialMode, string> = {
  opening_balance: "المتبقي عليه رصيدٌ سابق",
  prepaid_included: "دفع مسبقًا — الجلسات المتبقية مشمولة",
  per_session: "يدفع كل جلسة",
  installments: "أقساط عبر خطة علاج",
};

/** ما يفعله المستخدم في البرنامج بعد اللقطة — المال يمرّ من أبوابه القائمة، لا من اللقطة. */
export const LEGACY_FINANCIAL_HINT: Record<LegacyFinancialMode, string> = {
  opening_balance: "سجّل المبلغ المتبقي من «الرصيد الافتتاحي» في حساب المريض — لا فاتورة جديدة.",
  prepaid_included: "لا تُفوتر الشدّات القادمة — تُسجَّل الجلسات فقط.",
  per_session: "كل زيارة تُفوتر بإجراءاتها عند توقيعها كالمعتاد.",
  installments: "اربط خطة الأقساط القائمة (أو أنشئها من الخطط) — الأقساط تُحصَّل منها.",
};

export function isLegacyFinancialMode(value: unknown): value is LegacyFinancialMode {
  return typeof value === "string" && (LEGACY_FINANCIAL_MODES as readonly string[]).includes(value);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONTHS = 120;

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * التاريخ قبل `months` شهرًا من `today` (نصّ `YYYY-MM-DD` بلا مناطق زمنية).
 * اليوم يُقصّ إلى آخر الشهر حين لا يوجد (٣١ مايو − ٣ أشهر = ٢٨/٢٩ فبراير).
 */
export function monthsBefore(today: string, months: number): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const day = Number(today.slice(8, 10));
  const total = year * 12 + month - Math.max(0, Math.round(months));
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`;
}

/** الأشهر الكاملة (مقرّبة) بين تاريخين — للعرض ولحساب المدة الكلية. */
export function monthsBetween(from: string, to: string): number {
  return Math.max(0, Math.round(daysBetween(from, to) / 30.44));
}

export interface BaselineDraft {
  appliance: Appliance;
  arches: Arches;
  slot: SlotSize;
  bracketSystem: string | null;
  phase: OrthoPhase;
  upperWire: string | null;
  lowerWire: string | null;
  elastics: string | null;
  startDate: string;
  monthsElapsed: number;
  monthsRemaining: number;
  plannedMonths: number;
  responsibleDoctorId: number | null;
  financialMode: LegacyFinancialMode;
  remainingObjectives: string | null;
  planId: number | null;
  note: string | null;
}

const text = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

const positiveId = (value: unknown): number | null | "invalid" => {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : "invalid";
};

const wholeMonths = (value: unknown): number | null | "invalid" => {
  if (value === undefined || value === null || value === "") return null;
  const months = Number(value);
  if (!Number.isFinite(months) || months < 0 || months > MAX_MONTHS || Math.round(months) !== months) return "invalid";
  return months;
};

/**
 * يتحقّق من لقطة الحالة السابقة ويطبّعها.
 *
 * البدء إمّا تاريخٌ صريح (إن عرفه الطبيب) أو «منذ كم شهرًا» — والتاريخ الصريح يغلب. والمدة الكلية =
 * ما مضى + ما بقي، فتُحسب نسبة التقدّم على الشاشة كما لو فُتحت الحالة يوم بدأت.
 */
export function checkBaselineDraft(
  body: Record<string, unknown>,
  today: string,
): { ok: true; value: BaselineDraft } | { ok: false; message: string } {
  const appliance = typeof body.appliance === "string" && body.appliance in APPLIANCE_LABEL
    ? body.appliance as Appliance : "fixed_metal";
  const arches = typeof body.arches === "string" && body.arches in ARCHES_LABEL ? body.arches as Arches : "both";
  const slot = typeof body.slot === "string" && body.slot in SLOT_LABEL ? body.slot as SlotSize : "022";

  if (typeof body.phase !== "string" || !(body.phase in PHASE_LABEL)) {
    return { ok: false, message: "اختر المرحلة الحالية للعلاج." };
  }
  if (!isLegacyFinancialMode(body.financialMode)) {
    return { ok: false, message: "اختر كيف عومل المال قبل النظام." };
  }

  const remaining = wholeMonths(body.monthsRemaining);
  if (remaining === "invalid" || remaining === null) {
    return { ok: false, message: "الأشهر المتبقية رقمٌ صحيح بين 0 و120." };
  }

  let startDate: string;
  let elapsed: number;
  const rawStart = typeof body.startDate === "string" ? body.startDate.trim() : "";
  if (rawStart) {
    if (!isRealDate(rawStart)) return { ok: false, message: "تاريخ بدء العلاج غير صالح." };
    if (daysBetween(rawStart, today) < 0) return { ok: false, message: "تاريخ بدء الحالة السابقة لا يكون في المستقبل." };
    startDate = rawStart;
    elapsed = monthsBetween(rawStart, today);
    if (elapsed > MAX_MONTHS) return { ok: false, message: "تاريخ البدء أقدم من عشر سنوات — راجع التاريخ." };
  } else {
    const months = wholeMonths(body.monthsElapsed);
    if (months === "invalid" || months === null) {
      return { ok: false, message: "اكتب منذ كم شهرًا بدأ العلاج (0–120) أو تاريخ البدء." };
    }
    elapsed = months;
    startDate = monthsBefore(today, months);
  }

  const plannedMonths = Math.max(1, Math.min(MAX_MONTHS, elapsed + remaining));

  const responsibleDoctorId = positiveId(body.responsibleDoctorId);
  if (responsibleDoctorId === "invalid") return { ok: false, message: "الطبيب المسؤول غير صالح." };
  const planId = positiveId(body.planId);
  if (planId === "invalid") return { ok: false, message: "رقم الخطة غير صالح." };

  return {
    ok: true,
    value: {
      appliance, arches, slot,
      bracketSystem: text(body.bracketSystem, 80),
      phase: body.phase as OrthoPhase,
      upperWire: text(body.upperWire, 40),
      lowerWire: text(body.lowerWire, 40),
      elastics: text(body.elastics, 120),
      startDate,
      monthsElapsed: elapsed,
      monthsRemaining: remaining,
      plannedMonths,
      responsibleDoctorId,
      financialMode: body.financialMode,
      remainingObjectives: text(body.remainingObjectives, 1000),
      planId,
      note: text(body.note, 300),
    },
  };
}

/* ─────────────────── جلسة التقويم داخل توقيع الزيارة ─────────────────── */

export interface OrthoSessionDraft {
  caseId: number;
  phase: OrthoPhase | null;
  upperWire: string | null;
  lowerWire: string | null;
  elastics: ElasticClass;
  elasticNote: string | null;
  done: string | null;
  nextWeeks: number;
  note: string | null;
}

/**
 * جلسة التقويم التي تُرسل مع التوقيع — غيابها ليس خطأ (زيارةٌ بلا شدّة)، ووجودها ناقصًا خطأ عربي.
 */
export function checkOrthoSessionDraft(
  value: unknown,
): { ok: true; value: OrthoSessionDraft | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "بيانات جلسة التقويم غير صالحة." };
  const source = value as Record<string, unknown>;
  const caseId = Number(source.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) return { ok: false, message: "حالة التقويم غير محددة." };
  const nextWeeks = Math.round(Number(source.nextWeeks ?? 4));
  if (!Number.isFinite(nextWeeks) || nextWeeks < 1 || nextWeeks > 52) {
    return { ok: false, message: "المدة حتى الشدّة القادمة بين أسبوع و52 أسبوعًا." };
  }
  const phase = typeof source.phase === "string" && source.phase in PHASE_LABEL ? source.phase as OrthoPhase : null;
  return {
    ok: true,
    value: {
      caseId,
      phase,
      upperWire: text(source.upperWire, 40),
      lowerWire: text(source.lowerWire, 40),
      elastics: isElasticClass(source.elastics) ? source.elastics : "none",
      elasticNote: text(source.elasticNote, 120),
      done: text(source.done, 400),
      nextWeeks,
      note: text(source.note, 300),
    },
  };
}
