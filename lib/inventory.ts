/**
 * المخزون والمستهلكات السنية — المنطق الخالص.
 *
 * دستور هذه الوحدة بندان من المرحلة التاسعة، لا يُمسّان:
 *
 * ١) **الرصيد اشتقاقٌ رياضي من الحركات.** ما يُخزَّن حركةٌ ما — إدخالٌ أو صرفٌ أو
 *    تسوية — والرصيد مجموعها الموقَّع في أي لحظة. لا حقلَ رصيدٍ في القاعدة يُعدَّل،
 *    وتعديلُه كحقل رقمي محظور دستوريًا (ZONE_D): المواد تضيع في العيادات لا بسرقة
 *    كبيرة، بل بحقلٍ يُحرَّر يدويًا بلا حركةٍ يشهد عليها.
 *
 * ٢) **كل تسوية مبرَّرها موثَّق.** التسوية هي الحركة الوحيدة التي تُغيّر الرصيد بلا
 *    ورقة شراء ولا وصفة صرف، فلولاه صارت بابًا خلفيًا أنظف من السرقة: تصفير
 *    النقص كله بضغطة، والجرد يبدو سليمًا وهو مُزوَّر.
 *
 * صلاحيات الدفعات: الإدخال يحمل تاريخ صلاحية (دفعة)، والصرف يستهلك الدفعات
 * بالأقرب انتهاءً (FEFO) — القاعدة العملية في مستهلكات الأسنان قبل أن تنتهي
 * مادة على الرف ويُكتشف ذلك يوم الحاجة إليها.
 */

export type MovementKind = "in" | "out" | "adjust";

export const MOVEMENT_KINDS: MovementKind[] = ["in", "out", "adjust"];

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  in: "إدخال (شراء/استلام)",
  out: "صرف استهلاك",
  adjust: "تسوية جرد",
};

export function isMovementKind(value: unknown): value is MovementKind {
  return typeof value === "string" && (MOVEMENT_KINDS as string[]).includes(value);
}

export interface MovementLike {
  kind: MovementKind;
  /** موجبٌ للحركات؛ التسوية تحمل إشارتها (جمع أو نقص) في القيمة نفسها. */
  qty: number;
}

/** أثر حركة واحدة على الرصيد — الإدخال يزيد والصرف ينقص والتسوية كما وُقّعت. */
export function signedQty(kind: MovementKind, qty: number): number {
  if (kind === "out") return -Math.abs(qty);
  if (kind === "adjust") return qty;
  return Math.abs(qty);
}

/**
 * الرصيد المشتق: مجموع الحركات الموقَّع.
 *
 * هذا هو «الاشتقاق الرياضي» نصًّا في معيار القبول — والقاعدة تحسبه بجملة SUM
 * واحدة داخل المعاملة عند كل حركة، فلا يظهر رصيدٌ في شاشةٍ وخلافه في أخرى.
 */
export function deriveBalance(movements: MovementLike[]): number {
  return movements.reduce((sum, m) => sum + signedQty(m.kind, m.qty), 0);
}

export interface MovementCheck {
  ok: boolean;
  message?: string;
}

/**
 * فحص حركة قبل كتابتها — تُعاد الفحوص نفسها داخل معاملة القاعدة بعد قفل صفّ
 * البند، لأن موظفين اثنين يصرفان آخر علبتين في اللحظة نفسها كان سيُنقص أحدهما
 * رصيدًا لا يكفيه لو فُحص الرصيد خارج القفل.
 */
export function validateMovement(
  kind: MovementKind,
  qty: number,
  reason: string | null,
  balance: number,
): MovementCheck {
  if (!Number.isFinite(qty)) return { ok: false, message: "الكمية رقمٌ غير منطقي." };
  if (kind === "adjust") {
    if (qty === 0) {
      return { ok: false, message: "التسوية الصفرية لا معنى لها — إن صحّ الجرد فلا حركة." };
    }
    if (!reason || !reason.trim()) {
      return { ok: false, message: "سبب التسوية إلزامي — لا تسوية بلا مبرر موثَّق." };
    }
    return { ok: true };
  }
  if (qty <= 0) return { ok: false, message: "الكمية يجب أن تكون أكبر من صفر." };
  if (kind === "out" && qty > balance) {
    return { ok: false, message: `الرصيد الحالي (${balance}) لا يكفي صرف ${qty}.` };
  }
  return { ok: true };
}

export type StockStatus = "out" | "low" | "ok";

/**
 * موضع البند من حد الطلب: «منتهي» شامل الصفر والسالب (سالبٌ يعني نقصًا مسجَّلًا
 * بالحركات — يُصحَّح بتسوية موثَّقة لا بحذف حركة)، و«تحت الحد» قبل بلوغه.
 */
export function stockStatus(balance: number, minLevel: number): StockStatus {
  if (balance <= 0) return "out";
  if (minLevel > 0 && balance < minLevel) return "low";
  return "ok";
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  out: "منتهي",
  low: "تحت حد الطلب",
  ok: "متوفر",
};

/** الدفعة «قريبة الانتهاء» ضمن هذا العدد من الأيام — شهرٌ مهلة طلب البديل. */
export const EXPIRY_SOON_DAYS = 30;

export type ExpiryState = "expired" | "soon" | "ok";

export function expiryState(expiryDate: string, today: string): ExpiryState {
  const e = new Date(`${expiryDate}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  if (!Number.isFinite(e) || !Number.isFinite(t)) return "ok";
  const days = Math.round((e - t) / 86400000);
  if (days < 0) return "expired";
  if (days <= EXPIRY_SOON_DAYS) return "soon";
  return "ok";
}

export interface BatchLike extends MovementLike {
  id: number;
  createdAt: string;
  expiryDate: string | null;
}

export interface BatchRemaining {
  id: number;
  expiryDate: string | null;
  inQty: number;
  remaining: number;
}

export interface BatchResult {
  batches: BatchRemaining[];
  /** صافي التسويات غير المغطّاة بدفعات: يُضاف إلى بقايا الدفعات فيساوي الرصيد بالضبط. */
  adjustTotal: number;
}

/**
 * ما بقي من كل دفعة: الإدخالات بترتيب الأقرب صلاحيةً ثم الأقدم زمنًا، والصرف
 * يستهلكها بهذا الترتيب (FEFO). وما صرفَ زائدًا على مجموع الإدخال — ولا يجوز
 * إلا بتسوية موجبة سابقة (بضاعة وُجدت بالجرد دون دفعة مسجّلة) — تُغطّيه
 * التسويات فيصير «صافي التسويات» أقل من مجموعها الخام بمقدار الزائد، ومجموع
 * بقايا الدفعات زائد الصافي يساوي الرصيد المشتق بالضبط في كل تاريخٍ صالح.
 */
export function batchRemaining(movements: BatchLike[]): BatchResult {
  const byBatch = (a: BatchLike, b: BatchLike): number =>
    (a.expiryDate ?? "9999-12-31").localeCompare(b.expiryDate ?? "9999-12-31")
    || a.createdAt.localeCompare(b.createdAt)
    || a.id - b.id;

  const pool: BatchRemaining[] = movements
    .filter((m) => m.kind === "in")
    .sort(byBatch)
    .map((m) => ({ id: m.id, expiryDate: m.expiryDate, inQty: Math.abs(m.qty), remaining: Math.abs(m.qty) }));

  const outs = movements
    .filter((m) => m.kind === "out")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

  let uncovered = 0;
  for (const out of outs) {
    let need = Math.abs(out.qty);
    for (const batch of pool) {
      if (need <= 0) break;
      const take = Math.min(batch.remaining, need);
      batch.remaining -= take;
      need -= take;
    }
    uncovered += need;
  }

  const adjustTotal = movements
    .filter((m) => m.kind === "adjust")
    .reduce((sum, m) => sum + m.qty, 0) - uncovered;

  return { batches: pool, adjustTotal };
}

/** تصنيفات البنود — قائمة مفتوحة نصًّا لكن هذه هي المدخلات المتعارفة. */
export const ITEM_CATEGORY_LABEL: Record<string, string> = {
  anesthesia: "مخدر",
  filling: "حشوات",
  impression: "مواد طبع",
  ortho: "مستلزمات تقويم",
  surgical: "جراحة",
  hygiene: "تعقيم ونظافة",
  lab_supply: "توريد معمل",
  office: "قرطاسية ومكتب",
  other: "أخرى",
};

export function itemCategoryLabel(category: string): string {
  return ITEM_CATEGORY_LABEL[category] ?? category;
}
