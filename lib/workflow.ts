/**
 * رحلة المريض V2 — المنطق الخالص.
 *
 * المبدأ الحاكم (دستور النظام): نسجّل العلاج مرة واحدة → نوزّعه على الجلسات →
 * ننفّذه من الزيارة → النظام يولّد الاستحقاق تلقائيًا → التحصيل من مكان واحد →
 * نحدّد الجلسة القادمة.
 *
 * وهذه الوحدة هي العقل الذي يجعل ذلك ممكنًا بلا تناقض: قاعدةُ فوترةٍ لكل بند تحكم
 * **متى** يصبح المبلغ مستحقًا، وجلساتٌ تحكم **أين** نحن من العلاج، وزيارةٌ مخطَّطة
 * تحكم **ماذا** سنفعل التالي — والثلاثة منفصلة عن المال نفسه، لأن الرصيد لا يأتي
 * إلا من دفتر الحساب.
 */

/* ────────────────────────── قواعد الفوترة لكل بند ────────────────────────── */

/**
 * متى يصبح بندُ العلاج مستحقًا؟
 *
 * - `on_start`: كامل المبلغ عند أول جلسة — علاجٌ بدأ فاستحقّ، كالزراعة التي يُدفع
 *   جزؤها الأكبر عند الغرس.
 * - `on_completion`: كامل المبلغ عند إكمال البند — علاجٌ لا يستحقّ إلا تامًّا؛ فنصف
 *   عصبٍ لا قيمة له للمريض إن توقف.
 * - `per_session`: جزءٌ مع كل جلسة — يوزّع الثقل على الرحلة كلها، كعصبٍ ثلاث جلسات
 *   يدفع ثلثه كل مرة.
 *
 * الرصيد الافتتاحي والفاتورة لا تعرف هذه القاعدة: الاستحقاق يُبنى في **الزيارة**
 * لحظة التوقيع، وهذه الدالة تحدّد سطرَ الفاتورة الذي يظهر عندها.
 */
export type BillingRule = "on_start" | "on_completion" | "per_session";

export const BILLING_RULES: BillingRule[] = ["on_start", "on_completion", "per_session"];

export const BILLING_RULE_LABEL: Record<BillingRule, string> = {
  on_start: "عند البدء",
  on_completion: "عند الإكمال",
  per_session: "لكل جلسة",
};

export const DEFAULT_BILLING_RULE: BillingRule = "on_completion";

export function isBillingRule(value: unknown): value is BillingRule {
  return typeof value === "string" && (BILLING_RULES as string[]).includes(value);
}

export function normalizeBillingRule(value: unknown): BillingRule {
  return isBillingRule(value) ? value : DEFAULT_BILLING_RULE;
}

/* ────────────────────────── الجلسات العلاجية ────────────────────────── */

/**
 * جلسةٌ واحدة من بند علاج: عصبٌ ثلاث جلسات (فتح، تنظيف، حشو) ليس ثلاثة عصاب.
 * والجلسة تُنجز في زيارة — فحين تُوقَّع الزيارة تُعلَّم الجلسة منجزةً ويتقدّم البند.
 */
export type SessionStatus = "planned" | "in_progress" | "done" | "skipped";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  planned: "مخطَّطة",
  in_progress: "جارية",
  done: "منجزة",
  skipped: "متخطَّاة",
};

export const DEFAULT_SESSION_COUNT = 1;
export const MAX_SESSION_COUNT = 12;

export function normalizeSessionCount(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SESSION_COUNT;
  return Math.max(1, Math.min(MAX_SESSION_COUNT, n));
}

/**
 * مبالغ الجلسات: كم يُفوتر عند كل جلسة من بندٍ إجماليّه `totalMinor` على `count` جلسات.
 *
 * - `on_start`: كله في الأولى ثم صفر — والعمل بعدها استمرارٌ لا استحقاقٌ جديد.
 * - `on_completion`: صفر حتى الأخيرة ثم كله — دفعةُ الإنجاز.
 * - `per_session`: توزيعٌ لا يُضيع وحدةً صغرى، والفرق يُحمَّل على **الأخيرة** لا
 *   الأولى: خلافًا للقسط (الذي يُدفع اليوم) الجلسة الأخيرة هي لحظة الإكمال، وحملُ
 *   الفرق عليها يجعل «آخر جلسة» = «إكمال البند» رقمًا كما هي حدثًا.
 *
 * المجموع يساوي الإجمالي دائمًا — وإلا صار الاتفاق رقمًا ثالثًا لا سند له.
 */
export function sessionAmounts(
  rule: BillingRule,
  totalMinor: number,
  sessionCount: number,
): number[] {
  const count = normalizeSessionCount(sessionCount);
  const total = Math.max(0, Math.round(totalMinor));

  if (rule === "on_start") {
    return Array.from({ length: count }, (_, index) => (index === 0 ? total : 0));
  }
  if (rule === "on_completion") {
    return Array.from({ length: count }, (_, index) => (index === count - 1 ? total : 0));
  }

  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? base + remainder : base,
  );
}

/**
 * سطر الفاتورة المقترح لجلسةٍ بعينها — رقمٌ واحد لكل (بند، جلسة).
 *
 * `sessionIndex` من 1. والجلسات الزائدة عن العدّد تعود صفرًا لا تُفوتر: حمايةً من
 * جلسةٍ خامسة لعصبٍ ثلاث جلسات تدخل الفاتورة لأن أحدًا نسِي العدّ.
 */
export function priceForSession(
  rule: BillingRule,
  unitPriceMinor: number,
  sessionCount: number,
  sessionIndex: number,
): number {
  const amounts = sessionAmounts(rule, unitPriceMinor, sessionCount);
  if (sessionIndex < 1) return 0;
  if (sessionIndex > amounts.length) return 0;
  return amounts[sessionIndex - 1];
}

/** نصٌّ يشرح للطبيب لماذا هذا السعر — فالصفر بلا تفسير يبدو خطأً فيُكتب فوقه. */
export function sessionPriceNote(
  rule: BillingRule,
  sessionIndex: number,
  sessionCount: number,
): string {
  const ofTotal = `جلسة ${sessionIndex} من ${sessionCount}`;
  if (rule === "on_start") {
    return sessionIndex === 1
      ? `${ofTotal} — البند يُفوتر كاملًا عند بدئه.`
      : `${ofTotal} — البند استُحقّ في جلسة البدء؛ هذه استكمال بلا فوترة جديدة.`;
  }
  if (rule === "on_completion") {
    return sessionIndex === sessionCount
      ? `${ofTotal} — إكمال البند؛ يُفوتر كاملًا الآن.`
      : `${ofTotal} — يُفوتر البند كاملًا عند إكماله؛ هذه جلسة عمل بلا فوترة.`;
  }
  return `${ofTotal} — يُفوتر نصيب هذه الجلسة.`;
}

/* ────────────────────────── حالات بند الخطة في الرحلة ────────────────────────── */

/**
 * حالة البند السريرية — منفصلة عن حالته المالية عمدًا (المواصفة §٩).
 *
 * «مُنفَّذ ماليًا» و«منجز سريريًا» سؤالان مختلفان: بندٌ بدأ (on_start) فُوتر كاملًا
 * ولم يكتمل بعد = مستحقٌّ ماليًا **و** «قيد التنفيذ» سريريًا.
 */
export type WorkflowItemStatus =
  | "planned"
  | "scheduled"
  | "in_progress"
  | "done"
  | "deferred"
  | "cancelled";

export const WORKFLOW_ITEM_STATUS_LABEL: Record<WorkflowItemStatus, string> = {
  planned: "مخطَّط",
  scheduled: "مجدول",
  in_progress: "قيد التنفيذ",
  done: "مكتمل",
  deferred: "مؤجَّل",
  cancelled: "ملغى",
};

/** الجلسات المنجزة تعلن حالة البند — البند حصيلة جلساته لا رقمًا يُكتب فوقه. */
export function itemStatusFromSessions(
  sessions: { status: SessionStatus }[],
  cancelled = false,
): WorkflowItemStatus {
  if (cancelled) return "cancelled";
  const live = sessions.filter((session) => session.status !== "skipped");
  if (live.length === 0) return "planned";
  const done = live.filter((session) => session.status === "done").length;
  if (done === 0) return "planned";
  return done >= live.length ? "done" : "in_progress";
}

/** أول جلسة لم تُنجز بعد — «ماذا نعمل في الجلسة القادمة؟» */
export function nextOpenSession(
  sessions: { sequence: number; status: SessionStatus }[],
): { sequence: number } | null {
  const open = sessions
    .filter((session) => session.status === "planned" || session.status === "in_progress")
    .sort((a, b) => a.sequence - b.sequence);
  return open[0] ?? null;
}

/* ────────────────────────── الزيارات المخطَّطة ────────────────────────── */

/**
 * الزيارة المخطَّطة: **ليست موعدًا بعد**.
 *
 * هي قول النظام «ماذا سنعمل في الزيارة القادمة» قبل أن يقول الاستقبال «متى بالضبط».
 * والتحويل إلى موعدٍ يحدّد التاريخ والوقت فقط — لا يُعاد إدخال العلاج ولا سبب
 * الزيارة، لأن ذلك يعني أن الاتفاق يُكتب مرتين فيصير لكل كتابةٍ رأيٌ عند الخلاف.
 */
export type PlannedVisitStatus =
  | "planned"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

export const PLANNED_VISIT_STATUS_LABEL: Record<PlannedVisitStatus, string> = {
  planned: "غير مجدولة",
  scheduled: "مجدولة",
  in_progress: "زيارة قائمة",
  completed: "منجزة",
  cancelled: "ملغاة",
};

export function isPlannedVisitStatus(value: unknown): value is PlannedVisitStatus {
  return (
    typeof value === "string" &&
    (Object.keys(PLANNED_VISIT_STATUS_LABEL) as string[]).includes(value)
  );
}

/** عنوان الزيارة المخطَّطة من بنودها — «RCT 11 — جلسة 2» لا «زيارة رقم ٣». */
export function plannedVisitTitle(pieces: {
  serviceName: string;
  toothCode: number | null;
  sessionIndex: number | null;
  sessionCount: number;
}[]): string {
  if (pieces.length === 0) return "زيارة متابعة";
  const main = pieces[0];
  const tooth = main.toothCode ? ` ${main.toothCode}` : "";
  const session =
    main.sessionIndex !== null && main.sessionCount > 1
      ? ` — جلسة ${main.sessionIndex}`
      : "";
  const title = `${main.serviceName}${tooth}${session}`;
  if (pieces.length === 1) return title;
  return `${title} + ${pieces.length - 1} أخرى`;
}

/** مدة الزيارة المقترحة من جلساتها — جلسة عصب ليست ككشفٍ خمس دقائق. */
export const DEFAULT_VISIT_MINUTES = 30;

export function suggestVisitMinutes(sessions: { plannedDuration: number | null }[]): number {
  if (sessions.length === 0) return DEFAULT_VISIT_MINUTES;
  return sessions.reduce(
    (sum, session) => sum + (session.plannedDuration ?? DEFAULT_VISIT_MINUTES),
    0,
  );
}

/* ────────────────────────── فصل العلاج عن المديونية ────────────────────────── */

/**
 * الأرقام الستة التي يجب ألا تختلط أبدًا (المواصفة §٢٤):
 *
 * - المتفق عليه: قيمة خطط العلاج الحيّة — **وعدٌ**، ليس دَينًا.
 * - أُنجز من العلاج: ما نُفِّذ فعلًا.
 * - بقي من العلاج: الفرق — عملٌ سيُعمل، لا مبلغٌ يُطالَب به اليوم.
 * - فُوتر: ما أصدر له النظام فواتير — الاستحقاق الفعلي.
 * - دُفع: ما استلمه المركز.
 * - المديونية: فُوتر + الافتتاحي − دُفع — **من دفتر الحساب وحده**.
 *
 * خلط «باقي العلاج» بـ«الدين» يجعل مريضًا وافق على خطةٍ لم تبدأ يظهر مدينًا —
 * وهو ما يجعل قائمة المتأخرين كذبًا يُبرمج.
 */
export interface TreatmentFinancialSeparation {
  agreedMinor: number;
  treatmentDoneMinor: number;
  remainingTreatmentMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  debtMinor: number;
}

export function treatmentFinancialSeparation(input: {
  livePlans: { totalMinor: number; itemsDoneMinor: number }[];
  invoicedMinor: number;
  paidMinor: number;
  openingMinor: number;
}): TreatmentFinancialSeparation {
  const agreedMinor = input.livePlans.reduce((sum, plan) => sum + plan.totalMinor, 0);
  const treatmentDoneMinor = input.livePlans.reduce(
    (sum, plan) => sum + plan.itemsDoneMinor,
    0,
  );
  const debtMinor = input.invoicedMinor + input.openingMinor - input.paidMinor;
  return {
    agreedMinor,
    treatmentDoneMinor,
    remainingTreatmentMinor: Math.max(0, agreedMinor - treatmentDoneMinor),
    invoicedMinor: input.invoicedMinor,
    paidMinor: input.paidMinor,
    debtMinor,
  };
}

/* ────────────────────────── مصدر الاستحقاق — منع الفوترة المزدوجة ────────────────────────── */

/**
 * كل سطر فاتورة يعرف مصدره: `source_type` + `source_id`.
 *
 * القاعدة الإلزامية (المواصفة §٢٣): لا يمكن لبند العلاج نفسه أن يُفوتَر مرةً من
 * الخطة ومرةً من الزيارة. والضمانة بنيةٌ في القاعدة (فهرس فريد على المصدر) لا
 * نيّةٌ حسنة في الشاشة — فالمسارين يمرّان على نفس القيد فيرفض الثاني منهما.
 */
export const BILLING_SOURCE = {
  /** إجراء منفَّذ في زيارة — المصدر الأصلي لكل فوترة علاج. */
  visitProcedure: "visit_procedure",
  /** قسط خطة متفق عليها — مسار التقويم والأقساط. */
  installment: "installment",
  /** بند يدوي من الإدارة — الحالات الاستثنائية. */
  manual: "manual",
} as const;

export type BillingSource = (typeof BILLING_SOURCE)[keyof typeof BILLING_SOURCE];

/** يجيب: هل يحقّ لهذا المصدر أن يدخل الفوترة الآن؟ (فحص مزدوج فوق الفهرس الفريد) */
export function sameBillingSource(
  a: { sourceType: string | null; sourceId: number | null },
  b: { sourceType: string | null; sourceId: number | null },
): boolean {
  if (!a.sourceType || !b.sourceType) return false;
  if (a.sourceType !== b.sourceType) return false;
  return a.sourceId === b.sourceId;
}

/* ────────────────────────── «ماذا الآن؟» — محرّك الخطوة التالية ────────────────────────── */

/**
 * السؤال الذي يجب أن يجيب عنه رأس ملف المريض (المواصفة §٥٤):
 * ما وضع هذا المريض، وما المطلوب مني الآن؟
 *
 * الترتيب قصدي: الزيارة القائمة أولًا (مريضٌ على الكرسي الآن)، ثم موعد اليوم، ثم
 * الاستحقاق المالي (مريضٌ عند الشبّاك)، ثم الجدولة، ثم المتابعة. وأوّل خطوةٍ تنطبق
 * هي «الخطوة التالية» — لا قائمة أزرار يرتّبها المستخدم في رأسه.
 */
export type NextStepKind =
  | "continue_visit"
  | "start_today_visit"
  | "collect_payment"
  | "schedule_next_visit"
  | "follow_up"
  | "create_plan";

export const NEXT_STEP_LABEL: Record<NextStepKind, string> = {
  continue_visit: "استكمال زيارة اليوم",
  start_today_visit: "بدء زيارة اليوم",
  collect_payment: "تحصيل دفعة",
  schedule_next_visit: "حجز الجلسة القادمة",
  follow_up: "متابعة المريض",
  create_plan: "إنشاء خطة علاج",
};

export interface NextStepInput {
  /** زيارة قائمة لم تُوقَّع (المريض على الكرسي أو في الانتظار). */
  openVisit: { id: number } | null;
  /** موعد اليوم القادم/الحاضر. */
  todayAppointment: { id: number } | null;
  /** مديونية حالية > 0 (لمن يملك رؤيتها). */
  debtMinor: number | null;
  /** زيارة مخطَّطة قادمة لم تُحوَّل موعدًا. */
  unscheduledPlannedVisit: { id: number } | null;
  /** خطة علاج جارية. */
  activePlan: { id: number } | null;
}

export function nextStep(input: NextStepInput): { kind: NextStepKind; targetId: number | null } {
  if (input.openVisit) return { kind: "continue_visit", targetId: input.openVisit.id };
  if (input.todayAppointment) return { kind: "start_today_visit", targetId: input.todayAppointment.id };
  if (input.debtMinor !== null && input.debtMinor > 0) {
    return { kind: "collect_payment", targetId: null };
  }
  if (input.unscheduledPlannedVisit) {
    return { kind: "schedule_next_visit", targetId: input.unscheduledPlannedVisit.id };
  }
  if (input.activePlan) return { kind: "follow_up", targetId: input.activePlan.id };
  return { kind: "create_plan", targetId: null };
}
