/**
 * خدمات المواعيد — كتالوجٌ يملكه المالك، لا مصفوفةٌ في الشيفرة.
 *
 * كانت أنواع الزيارات تسعةً مكتوبةً في `lib/schedule.ts`، ومدّةُ كلٍّ منها رقمًا
 * ثابتًا. فإضافةُ «تركيب مسمار تقويم» أو «تسليم متحرّك» تعني نشرةً برمجية — وهذا
 * يعني عمليًّا أنها لا تُضاف، فيُحجز العمل الجديد تحت «أخرى» بمدّةٍ لا تشبهه،
 * فيكذب حساب السعة كلُّه.
 *
 * **والفصل الحاكم**: هذه خدمةُ **جدولة** لا إجراءٌ **سريريّ/مالي**. الجدولة تسأل
 * «كم يشغل هذا من الوقت والكرسي والطبيب»، والإجراء السريري يسأل «ماذا عُمل للمريض
 * وبكم يُحاسَب». وموعدٌ واحد قد يحمل إجراءاتٍ عدّة. فلا يُدمج المجالان في جدول.
 */

export type ServiceSpecialty =
  | "general" | "orthodontics" | "endodontics" | "surgery" | "implantology"
  | "prosthodontics" | "periodontics" | "pediatric" | "radiology"
  | "consultation" | "emergency" | "cosmetic" | "other";

export const SPECIALTY_LABEL: Record<ServiceSpecialty, string> = {
  general: "عام",
  orthodontics: "تقويم",
  endodontics: "علاج جذور",
  surgery: "جراحة",
  implantology: "زراعة",
  prosthodontics: "تركيبات",
  periodontics: "لثة",
  pediatric: "أطفال",
  radiology: "أشعة وسجلات",
  consultation: "كشف واستشارة",
  emergency: "طوارئ",
  cosmetic: "تجميل",
  other: "أخرى",
};

export const SPECIALTIES = Object.keys(SPECIALTY_LABEL) as ServiceSpecialty[];

export interface AppointmentService {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  specialty: ServiceSpecialty;
  defaultDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  requiresProvider: boolean;
  requiresChair: boolean;
  allowsConcurrentProviderWork: boolean;
  consumesEmergencyReserve: boolean;
  priority: number;
  badgeClass: string | null;
  isActive: boolean;
  sortOrder: number;
  legacyType: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AppointmentServiceInput {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  specialty: string;
  defaultDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  requiresProvider: boolean;
  requiresChair: boolean;
  allowsConcurrentProviderWork: boolean;
  consumesEmergencyReserve: boolean;
  priority: number;
  badgeClass?: string | null;
  isActive: boolean;
  sortOrder: number;
}

/* ── حدود التحقّق ─────────────────────────────────────────────────────────── */

export const MIN_DURATION = 5;
export const MAX_DURATION = 480;
export const MAX_BUFFER = 120;
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 999;

/** الرمز هوية: لاتينيّ كبير وأرقام وشرطة سفلية — يُقرأ في تكاملٍ ولا يُترجم. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

export function normalizeCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * تحقّقٌ خالص — يُستدعى في الخادم قبل الكتابة.
 *
 * والفاصل **صفرٌ قيمةٌ صحيحة**: متابعةُ تقويمٍ عشر دقائق بلا تجهيزٍ قبلها ولا بعدها
 * أمرٌ واقع في مركزٍ يرى ثلاثين مريضًا في المساء. وفرضُ خمس دقائق على كل موعدٍ
 * «للنظافة» يأكل ساعتين من يومٍ لا يملكهما.
 */
export function validateService(input: AppointmentServiceInput): string | null {
  const code = normalizeCode(input.code);
  if (!CODE_PATTERN.test(code)) {
    return "رمز الخدمة: أحرف لاتينية كبيرة وأرقام وشرطة سفلية، من حرفين إلى أربعين.";
  }
  if (!(input.nameAr ?? "").trim()) return "اسم الخدمة بالعربية مطلوب.";
  if ((input.nameAr ?? "").trim().length > 80) return "اسم الخدمة أطول من ثمانين حرفًا.";
  if (!SPECIALTIES.includes(input.specialty as ServiceSpecialty)) {
    return "التخصص غير معروف.";
  }
  if (!Number.isInteger(input.defaultDurationMinutes)
    || input.defaultDurationMinutes < MIN_DURATION
    || input.defaultDurationMinutes > MAX_DURATION) {
    return `المدة الافتراضية بين ${MIN_DURATION} و${MAX_DURATION} دقيقة.`;
  }
  for (const [label, value] of [
    ["وقت التجهيز قبل الموعد", input.bufferBeforeMinutes],
    ["وقت التجهيز بعد الموعد", input.bufferAfterMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_BUFFER) {
      return `${label}: عددٌ صحيح من صفر إلى ${MAX_BUFFER}.`;
    }
  }
  if (!Number.isInteger(input.priority)
    || input.priority < MIN_PRIORITY || input.priority > MAX_PRIORITY) {
    return `الأولوية بين ${MIN_PRIORITY} و${MAX_PRIORITY}.`;
  }
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999) {
    return "الترتيب عددٌ صحيح من صفر إلى ٩٩٩٩.";
  }
  /* خدمةٌ لا تحتاج طبيبًا ولا كرسيًّا لا تشغل شيئًا — فما معنى حجزها؟ تُقبل، لكن
     تُقال للمالك صراحةً بدل أن تمرّ صامتةً فيحتار لماذا لا تُحسب في السعة. */
  return null;
}

/** نافذة الإشغال الفعلية: الفاصل جزءٌ من الحجز لا زينةٌ حوله. */
export function effectiveWindow(input: {
  startMinutes: number;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}): { start: number; end: number } {
  return {
    start: input.startMinutes - Math.max(0, input.bufferBeforeMinutes),
    end: input.startMinutes + Math.max(0, input.durationMinutes)
      + Math.max(0, input.bufferAfterMinutes),
  };
}

/**
 * تداخل نافذتين — والنهايةُ الملامسة ليست تداخلًا.
 *
 * موعدٌ تنتهي نافذته ١٠:٢٠ وآخر تبدأ نافذته ١٠:٢٠ لا يتزاحمان: الكرسي يخلو في
 * اللحظة نفسها التي يُشغل فيها. واعتبارُهما متداخلين يُهدر فتحةً في كل يوم.
 */
export function windowsOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/* ── الكتالوج الابتدائي ───────────────────────────────────────────────────── */

/**
 * بذرةٌ مفيدة لا عقدٌ أبديّ.
 *
 * تُزرع مرّةً واحدة عند أوّل تشغيل، وكلُّ قيمةٍ فيها قابلةٌ للتحرير من الشاشة في
 * اليوم نفسه. و`legacyType` يربط الخدمة بالرمز النصّيّ القديم المخزَّن في مواعيد
 * سابقة، فلا يفقد موعدٌ قديم اسمه.
 */
export const STARTER_SERVICES: readonly (AppointmentServiceInput & { legacyType?: string })[] = [
  { code: "CONSULTATION", nameAr: "كشف واستشارة", specialty: "consultation", defaultDurationMinutes: 10,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-blue-200 bg-blue-50 text-blue-800", isActive: true, sortOrder: 10,
    legacyType: "consultation" },
  { code: "SHORT_REVIEW", nameAr: "مراجعة قصيرة", specialty: "consultation", defaultDurationMinutes: 5,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 60,
    badgeClass: "border-sky-200 bg-sky-50 text-sky-800", isActive: true, sortOrder: 20 },
  { code: "ORTHO_FOLLOW_UP", nameAr: "متابعة تقويم / شدّ", specialty: "orthodontics", defaultDurationMinutes: 10,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800", isActive: true, sortOrder: 30,
    legacyType: "follow_up" },
  { code: "ORTHO_WIRE_CHANGE", nameAr: "تغيير سلك تقويم", specialty: "orthodontics", defaultDurationMinutes: 15,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800", isActive: true, sortOrder: 40 },
  { code: "BRACKET_REBOND", nameAr: "إعادة لصق براكيت", specialty: "orthodontics", defaultDurationMinutes: 15,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800", isActive: true, sortOrder: 50 },
  { code: "BRACKET_BONDING", nameAr: "لصق براكيت", specialty: "orthodontics", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800", isActive: true, sortOrder: 60 },
  { code: "ORTHO_RECORDS", nameAr: "سجلّات وأشعة تقويم", specialty: "radiology", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: false, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 70,
    badgeClass: "border-cyan-200 bg-cyan-50 text-cyan-800", isActive: true, sortOrder: 70 },
  { code: "ORTHO_START", nameAr: "بدء علاج تقويم", specialty: "orthodontics", defaultDurationMinutes: 40,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 40,
    badgeClass: "border-indigo-300 bg-indigo-100 text-indigo-900", isActive: true, sortOrder: 80 },
  { code: "ORTHO_DEBOND", nameAr: "إنهاء تقويم وفكّ", specialty: "orthodontics", defaultDurationMinutes: 40,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 40,
    badgeClass: "border-indigo-300 bg-indigo-100 text-indigo-900", isActive: true, sortOrder: 90 },
  { code: "DENTAL_EMERGENCY", nameAr: "طوارئ وألم حاد", specialty: "emergency", defaultDurationMinutes: 10,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: true, priority: 10,
    badgeClass: "border-red-300 bg-red-100 text-red-800", isActive: true, sortOrder: 100,
    legacyType: "emergency" },
  { code: "FILLING", nameAr: "حشوة وترميم", specialty: "general", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800", isActive: true, sortOrder: 110,
    legacyType: "filling" },
  { code: "ROOT_CANAL", nameAr: "علاج عصب وجذور", specialty: "endodontics", defaultDurationMinutes: 30,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 40,
    badgeClass: "border-purple-200 bg-purple-50 text-purple-800", isActive: true, sortOrder: 120,
    legacyType: "endo" },
  { code: "EXTRACTION", nameAr: "خلع وجراحة صغرى", specialty: "surgery", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 40,
    badgeClass: "border-rose-200 bg-rose-50 text-rose-800", isActive: true, sortOrder: 130,
    legacyType: "surgery" },
  { code: "IMPLANT_PLACEMENT", nameAr: "زراعة سنّية", specialty: "implantology", defaultDurationMinutes: 45,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 10, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 30,
    badgeClass: "border-rose-300 bg-rose-100 text-rose-900", isActive: true, sortOrder: 140 },
  { code: "PROSTHETIC_IMPRESSION", nameAr: "طبعة تركيبات", specialty: "prosthodontics", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-teal-200 bg-teal-50 text-teal-800", isActive: true, sortOrder: 150,
    legacyType: "prosthetics" },
  { code: "PROSTHETIC_TRY_IN", nameAr: "تجربة تركيبات", specialty: "prosthodontics", defaultDurationMinutes: 15,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-teal-200 bg-teal-50 text-teal-800", isActive: true, sortOrder: 160 },
  { code: "PROSTHETIC_DELIVERY", nameAr: "تسليم تركيبات", specialty: "prosthodontics", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50,
    badgeClass: "border-teal-200 bg-teal-50 text-teal-800", isActive: true, sortOrder: 170 },
  { code: "CLEANING", nameAr: "تنظيف وتقليح", specialty: "periodontics", defaultDurationMinutes: 30,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 5, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 60,
    badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-800", isActive: true, sortOrder: 180,
    legacyType: "cleaning" },
  { code: "GENERAL_PROCEDURE", nameAr: "إجراء عام", specialty: "general", defaultDurationMinutes: 20,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresProvider: true, requiresChair: true,
    allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 80,
    badgeClass: "border-slate-200 bg-slate-100 text-slate-700", isActive: true, sortOrder: 190,
    legacyType: "other" },
];

/** بحثٌ يقبل العربية والرمز والتخصّص — لا يُشترط الرمز اللاتينيّ. */
export function searchServices(services: AppointmentService[], term: string): AppointmentService[] {
  const needle = (term ?? "").trim().toLowerCase();
  if (!needle) return services;
  return services.filter((service) =>
    service.nameAr.toLowerCase().includes(needle)
    || service.code.toLowerCase().includes(needle)
    || (service.nameEn ?? "").toLowerCase().includes(needle)
    || SPECIALTY_LABEL[service.specialty].includes(needle)
    || service.specialty.toLowerCase().includes(needle));
}
