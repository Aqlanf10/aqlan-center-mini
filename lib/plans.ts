import { addDays } from "./schedule";

/**
 * خطط العلاج والأقساط — المنطق الخالص.
 *
 * هذه ليست ميزة إضافية: هي **نموذج عمل عيادة التقويم**. مريض التقويم يتفق على سعر
 * كامل — مليون ريال مثلًا — ويدفعه على ثمانية عشر شهرًا مع كل زيارة شدّ. وبلا خطة
 * أقساط يصير الحساب فوضى: فاتورة واحدة ضخمة تجعل المريض «مدينًا بمليون» من أول يوم،
 * أو فواتير متفرقة لا تقول كم بقي من العلاج ولا متى يُنهى.
 *
 * القاعدة التي تحكم التصميم: **الخطة اتفاق، والقسط استحقاق، والدفعة تحصيل.** ثلاثة
 * أشياء مختلفة كان خلطها هو ما يجعل مرضى التقويم أصعب ملفات العيادة.
 */

export type PlanStatus = "active" | "completed" | "cancelled";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  active: "جارية",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

export interface Installment {
  /** ترتيب القسط: 1، 2، 3… */
  number: number;
  dueDate: string;
  amountMinor: number;
}

/**
 * يوزّع مبلغًا على أقساط متساوية بلا أن يضيع ريال.
 *
 * القسمة على ثلاثة تترك كسرًا، وتقريب كل قسط على حدة يجعل المجموع يخالف الاتفاق
 * بريالات — وهي ريالات يجادل عليها المريض بحق. الفرق كله يُحمَّل على **القسط الأول**
 * لا الأخير: الأول يُدفع اليوم والمريض حاضر، والأخير يُدفع بعد سنة وقد نُسي الاتفاق.
 */
export function splitInstallments(
  totalMinor: number,
  count: number,
  firstDueDate: string,
  everyDays = 30,
): Installment[] {
  const safeCount = Math.max(1, Math.min(60, Math.round(count)));
  const total = Math.max(0, Math.round(totalMinor));
  const base = Math.floor(total / safeCount);
  const remainder = total - base * safeCount;

  return Array.from({ length: safeCount }, (_, index) => ({
    number: index + 1,
    dueDate: addDays(firstDueDate, index * everyDays),
    amountMinor: index === 0 ? base + remainder : base,
  }));
}

export interface PlanLike {
  totalMinor: number;
  status: PlanStatus;
  installments: { number: number; dueDate: string; amountMinor: number }[];
}

export interface PlanProgress {
  totalMinor: number;
  /** ما استحقّ حتى اليوم من الأقساط. */
  dueToDateMinor: number;
  paidMinor: number;
  remainingMinor: number;
  /** المتأخر: ما استحقّ ولم يُغطَّ بالتحصيل. */
  overdueMinor: number;
  nextDueDate: string | null;
  nextDueAmountMinor: number;
  paidCount: number;
  count: number;
}

/**
 * حالة الخطة اليوم.
 *
 * التحصيل يُنسب إلى الأقساط بالأقدم أولًا — كما يوزَّع على الفواتير — لأن المريض يدفع
 * «على حسابه» لا على قسط بعينه.
 *
 * والمتأخر يُحسب من **ما استحقّ حتى اليوم** لا من الإجمالي: مريضٌ اتفق على مليون
 * ودفع مئتين في شهره الثاني ليس متأخرًا بثمانمئة — هو ملتزم تمامًا. والخلط بينهما
 * يجعل كل مرضى التقويم يظهرون مدينين، فتفقد قائمة المتأخرين معناها.
 */
export function planProgress(plan: PlanLike, paidMinor: number, today: string): PlanProgress {
  const ordered = [...plan.installments].sort((a, b) => a.number - b.number);
  const totalMinor = plan.totalMinor;

  let pool = Math.max(0, paidMinor);
  let dueToDateMinor = 0;
  let overdueMinor = 0;
  let paidCount = 0;
  let nextDueDate: string | null = null;
  let nextDueAmountMinor = 0;

  for (const installment of ordered) {
    const covered = Math.min(pool, installment.amountMinor);
    pool -= covered;
    const fullyPaid = covered >= installment.amountMinor;
    if (fullyPaid) paidCount += 1;

    if (installment.dueDate <= today) {
      dueToDateMinor += installment.amountMinor;
      overdueMinor += installment.amountMinor - covered;
    } else if (nextDueDate === null && !fullyPaid) {
      nextDueDate = installment.dueDate;
      nextDueAmountMinor = installment.amountMinor - covered;
    }
  }

  return {
    totalMinor,
    dueToDateMinor,
    paidMinor: Math.min(paidMinor, totalMinor),
    remainingMinor: Math.max(0, totalMinor - paidMinor),
    overdueMinor: Math.max(0, overdueMinor),
    nextDueDate,
    nextDueAmountMinor,
    paidCount,
    count: ordered.length,
  };
}

/** رسالة تذكير بقسط — تُرسل قبل الاستحقاق أو بعده بلهجة واحدة: تذكير لا مطالبة. */
export function installmentReminderText(input: {
  patientName: string;
  amountText: string;
  dueDateText: string;
  overdue: boolean;
  clinicName: string;
  clinicPhone: string;
}): string {
  return [
    `السلام عليكم ${input.patientName}،`,
    ``,
    input.overdue
      ? `تذكير بقسط علاجكم المستحق ${input.dueDateText} بمبلغ ${input.amountText}.`
      : `نذكّركم بقسط علاجكم القادم ${input.dueDateText} بمبلغ ${input.amountText}.`,
    `يسعدنا استقبالكم، وإن احتجتم ترتيبًا آخر أخبرونا.`,
    ``,
    `${input.clinicName}`,
    `للتواصل: ${input.clinicPhone}`,
  ].join("\n");
}

/* ────────────────────────── الخطة السريرية: بنودٌ مسعّرة وموافقة ────────────────────────── */

/**
 * **الخطة اتفاق** — وهذا هو الجزء الذي كان ناقصًا منها.
 *
 * الخطة الأولى في هذا الملف مالية: مبلغٌ يُكتب باليد ويُقسَّط. وهي تكفي مريض التقويم
 * الذي اتفق على رقمٍ واحد، ولا تكفي غيره: مريضٌ عنده أربع حشوات وعصبٌ وتاج يريد أن
 * يعرف **ماذا سيُعمل له بالضبط، على أيّ سن، وبكم** قبل أن يوافق. والرقم الإجمالي
 * وحده لا يجيب، فيصير الخلاف بعد شهرين على ما كان داخلًا في الاتفاق وما لم يكن.
 *
 * فالبنود هي الاتفاق نفسه مفصَّلًا، **والإجمالي يُشتقّ منها** لا يُكتب باليد — رقمان
 * لعملٍ واحد هو تحديدًا ما يُنتج الخلاف.
 */

export type PlanItemStatus = "planned" | "done" | "cancelled";

export const PLAN_ITEM_STATUS_LABEL: Record<PlanItemStatus, string> = {
  planned: "مخطَّط",
  done: "منفَّذ",
  cancelled: "ملغى",
};

export interface PlanItemLike {
  serviceId: number | null;
  toothCode: number | null;
  quantity: number;
  unitPriceMinor: number;
  status: PlanItemStatus;
}

/** الملغى لا يُحسب: بندٌ أُلغي ليس دَينًا على المريض ولا وعدًا عليه. */
export function itemsTotal(items: PlanItemLike[]): number {
  return items
    .filter((item) => item.status !== "cancelled")
    .reduce((sum, item) =>
      sum + Math.max(0, Math.round(item.quantity)) * Math.max(0, Math.round(item.unitPriceMinor)), 0);
}

export interface PlanItemsProgress {
  count: number;
  doneCount: number;
  totalMinor: number;
  doneMinor: number;
  remainingMinor: number;
}

/**
 * تقدّم العلاج — لا تقدّم الدفع.
 *
 * سؤالان مختلفان يخلطهما كثيرٌ من الأنظمة: «كم دفع» و«كم أُنجز». مريضٌ دفع كامل
 * المبلغ مقدَّمًا لم يُعالَج بعد، ومريضٌ أُنجز علاجه كلّه قد لا يكون سدّد. وشريطُ
 * تقدّمٍ واحد لهما يكذب على الطرفين.
 */
export function planItemsProgress(items: PlanItemLike[]): PlanItemsProgress {
  const live = items.filter((item) => item.status !== "cancelled");
  const done = live.filter((item) => item.status === "done");
  const totalMinor = itemsTotal(live);
  const doneMinor = itemsTotal(done.map((item) => ({ ...item, status: "planned" as const })));
  return {
    count: live.length,
    doneCount: done.length,
    totalMinor,
    doneMinor,
    remainingMinor: Math.max(0, totalMinor - doneMinor),
  };
}

/**
 * هل تصلح الخطة للموافقة؟
 *
 * الموافقة على خطةٍ فارغة توقيعٌ على بياض، والموافقة مرتين تُنتج اتفاقين لعملٍ واحد.
 */
export function canConsent(plan: {
  status: PlanStatus;
  consentAt: string | null;
  items: PlanItemLike[];
}): { ok: true } | { ok: false; message: string } {
  if (plan.consentAt) return { ok: false, message: "الخطة موافَق عليها سلفًا." };
  if (plan.status !== "active") return { ok: false, message: "الخطة غير جارية." };
  if (plan.items.filter((item) => item.status !== "cancelled").length === 0) {
    return { ok: false, message: "أضف بنود الخطة قبل تسجيل الموافقة." };
  }
  return { ok: true };
}

/**
 * هل يجوز تعديل بنود الخطة؟
 *
 * بعد الموافقة: لا. والسبب ليس تشدّدًا إداريًّا — الموافقة وثيقةٌ وقّعها المريض على
 * بنودٍ بعينها بأسعارٍ بعينها. وتعديلها بعده يجعل ما وقّع عليه شيئًا وما في النظام
 * شيئًا آخر، وهي أوّل ما يُطلب يوم الخلاف. المستجدّ يُوثَّق **بخطةٍ جديدة** تُوافَق
 * عليها كما وُوفق على الأولى.
 */
export function canEditItems(plan: {
  status: PlanStatus;
  consentAt: string | null;
}): { ok: true } | { ok: false; message: string } {
  if (plan.consentAt) {
    return { ok: false, message: "الخطة موافَق عليها؛ بنودها لا تُعدَّل. وثّق المستجدّ بخطة جديدة." };
  }
  if (plan.status !== "active") return { ok: false, message: "الخطة غير جارية." };
  return { ok: true };
}

/**
 * أيّ بنود الخطة نفّذتها هذه الزيارة؟
 *
 * هذا هو ما يجعل الخطة حيّةً لا ورقةً تُكتب وتُنسى: الطبيب يعمل في الزيارة كما
 * يعمل دائمًا، فتُشطب بنود الخطة من نفسها. وبلا هذا يبقى على أحدهم أن يتذكّر تحديث
 * الخطة يدويًّا — فلا يتذكّر، فتُظهر الخطة بعد سنةٍ عملًا أُنجز على أنه لم يبدأ.
 *
 * والمطابقة بالخدمة **والسن** معًا: حشوةٌ على السن ١٦ لا تُنفّذ بندَ حشوةٍ على ٢٦.
 * وبندٌ بلا سن يُطابق إجراءً بلا سن — الكشف والتنظيف ليسا على سنّ بعينه.
 */
export function matchPlanItems<T extends { id: number } & PlanItemLike>(
  items: T[],
  procedures: { serviceId: number; toothCode: number | null; quantity: number }[],
): number[] {
  const open = items
    .filter((item) => item.status === "planned")
    .sort((a, b) => a.id - b.id);
  const taken = new Set<number>();

  for (const procedure of procedures) {
    let remaining = Math.max(0, Math.round(procedure.quantity));
    for (const item of open) {
      if (remaining <= 0) break;
      if (taken.has(item.id)) continue;
      if (item.serviceId !== procedure.serviceId) continue;
      if ((item.toothCode ?? null) !== (procedure.toothCode ?? null)) continue;
      taken.add(item.id);
      remaining -= Math.max(1, Math.round(item.quantity));
    }
  }

  return [...taken].sort((a, b) => a - b);
}
