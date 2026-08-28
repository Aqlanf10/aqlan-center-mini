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
