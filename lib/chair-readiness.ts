/**
 * (CHAIR-1) جاهزية المريض للكرسي، وبوابة النداء/الإجلاس، ومعلومة الرصيد، ومراحل الرحلة —
 * منطقٌ خالص بلا قاعدة ولا واجهة، يُختبر بجدول.
 *
 * المبادئ (docs/RECEPTION_TO_CHECKOUT_CHANGE_IMPACT.md §3 Slices 1–5):
 * - **القائمة مشتقة لا مخزَّنة**: التاريخ الطبي (محدَّث أم لا)، التنبيه الطبي وأعلام المريض،
 *   استمارة اليوم. المخزَّن وحده الإقرار (`visits.cleared_at/cleared_by`).
 * - **قيم `visits.status` لا تتغيّر**: الجاهزية شارةٌ فوق الحالة لا حالةٌ جديدة.
 * - **الزحمة أولًا**: البوابة تحذّر ولا تمنع ما لم يفعّل المالك `ops.require_clearance_before_call`،
 *   والطوارئ تتجاوز المنع بسببٍ مكتوب يُدقَّق. والإعداد المغلق لا يضيف نقرةً واحدة.
 * - **الرصيد معلومة لا منع**: لا يوقف علاجًا، ولا يحوّل دفعةً مقدَّمة إلى إيراد.
 */
import { deriveAlerts, reviewDue, type Allergy, type Answer, type AsaClass } from "./medical-history";
import { CURRENCIES, isCurrency, type Currency } from "./money";

// ─── Slice 1 — قائمة الجاهزية المشتقة ──────────────────────────────────────

export type ReadinessState = "ok" | "attention" | "info";
export type ReadinessKey = "file" | "medical_history" | "alerts" | "flags" | "intake";

export interface ReadinessItem {
  key: ReadinessKey;
  state: ReadinessState;
  label: string;
}

/** ما تقرؤه القاعدة لكل زيارة — حقائق لا أحكام. */
export interface ReadinessFacts {
  patientId: number | null;
  /** التنبيه النصي القديم في ملف المريض. */
  medicalAlert: string | null;
  flags: readonly string[];
  /** آخر نسخة تاريخ طبي، أو null إن لم يُسجَّل تاريخٌ قط. */
  history: {
    recordedAt: string;
    answers: Record<string, Answer>;
    allergies: readonly Allergy[];
    asaClass: AsaClass | null;
  } | null;
  /** آخر استمارة صحية أُرسلت في يوم الزيارة نفسه (تسجيل ذاتي/بوابة)، إن وُجدت. */
  intakeAt: string | null;
}

export interface ReadinessChecklist {
  items: ReadinessItem[];
  /** عدد البنود التي تحتاج اطلاعًا قبل الإقرار. */
  attention: number;
  /** نصوص التنبيهات الطبية كما تظهر في الشارة (القديم + المشتق من آخر نسخة). */
  alerts: string[];
}

/**
 * يشتق قائمة الجاهزية.
 *
 * - بلا ملف (مريض مشى): بندٌ واحد «بلا ملف» — لا تاريخ يُقرأ ولا تنبيه.
 * - التاريخ الطبي: غائب أو تجاوز مدة المراجعة ⇒ يحتاج اطلاعًا؛ وإلا محدَّث.
 * - التنبيهات: أي تنبيهٍ طبي ⇒ يحتاج اطلاعًا (الإقرار هو ما يشهد أنه قُرئ قبل الكرسي).
 * - الأعلام (VIP، يحتاج مرافقًا…): معلومة تُعرض ولا تُحسب.
 * - الاستمارة: وصولها اليوم ✓، وغيابها معلومة — كثيرٌ من المرضى لا يملؤونها ولا يُعطَّلون.
 */
export function deriveReadiness(facts: ReadinessFacts, reviewMonths: number, today: string): ReadinessChecklist {
  if (facts.patientId === null) {
    return {
      items: [{ key: "file", state: "attention", label: "بلا ملف — اربطه بملفٍّ أو افتحه" }],
      attention: 1,
      alerts: [],
    };
  }
  const items: ReadinessItem[] = [];
  const review = reviewDue(facts.history?.recordedAt ?? null, reviewMonths, today);
  if (!facts.history) {
    items.push({ key: "medical_history", state: "attention", label: "لا تاريخ طبي مسجَّل" });
  } else if (review.due) {
    items.push({ key: "medical_history", state: "attention", label: "التاريخ الطبي يحتاج مراجعة" });
  } else {
    items.push({ key: "medical_history", state: "ok", label: "التاريخ الطبي محدَّث" });
  }

  const alerts = [
    ...(facts.medicalAlert?.trim() ? [facts.medicalAlert.trim()] : []),
    ...(facts.history
      ? deriveAlerts({ answers: facts.history.answers, allergies: [...facts.history.allergies], asaClass: facts.history.asaClass })
        .map((alert) => alert.label)
      : []),
  ];
  items.push(alerts.length > 0
    ? { key: "alerts", state: "attention", label: `تنبيه طبي: ${alerts.join(" • ")}` }
    : { key: "alerts", state: "ok", label: "لا تنبيهات طبية" });

  const flags = facts.flags.map((flag) => flag.trim()).filter(Boolean);
  if (flags.length > 0) items.push({ key: "flags", state: "info", label: `أعلام: ${flags.join(" · ")}` });

  items.push(facts.intakeAt
    ? { key: "intake", state: "ok", label: "استمارة اليوم مستلمة" }
    : { key: "intake", state: "info", label: "لا استمارة اليوم" });

  return { items, attention: items.filter((item) => item.state === "attention").length, alerts };
}

// ─── Slice 2 — الرصيد عند الوصول (معلومة لا منع) ───────────────────────────

/** عتبة التنبيه لكل عملة بوحداتها الصغرى. غياب العملة = لا تنبيه لها. */
export type BalanceWarningThresholds = Partial<Record<Currency, number>>;

/**
 * يقرأ الإعداد `reception.balance_warning_minor`.
 *
 * الصيغة JSON لكل عملة بوحداتها الصغرى: `{"YER":50000,"USD":10000}`. الفارغ أو `{}` = مغلق
 * (الافتراضي). وعتبةٌ واحدة فوق كل العملات مرفوضة بنيويًّا — «٥٠٠٠٠» بالريال غيرها بالدولار.
 */
export function parseBalanceWarning(raw: string | null | undefined):
  | { ok: true; thresholds: BalanceWarningThresholds }
  | { ok: false; message: string } {
  const value = (raw ?? "").trim();
  if (value === "") return { ok: true, thresholds: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    return { ok: false, message: "الصيغة JSON لكل عملة، مثل {\"YER\":50000} — أو فارغ للإيقاف." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "الصيغة JSON لكل عملة، مثل {\"YER\":50000} — أو فارغ للإيقاف." };
  }
  const thresholds: BalanceWarningThresholds = {};
  for (const [key, amount] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isCurrency(key)) return { ok: false, message: `عملة غير معروفة: ${key}.` };
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      return { ok: false, message: `عتبة ${key} عدد صحيح غير سالب بالوحدات الصغرى.` };
    }
    if (amount > 0) thresholds[key] = amount;
  }
  return { ok: true, thresholds };
}

export interface BalanceLine {
  currency: Currency;
  /** المستحق على المريض في هذه العملة (موجب). */
  dueMinor: number;
  /** بلغ عتبة التنبيه المضبوطة لهذه العملة — للّون فقط، لا يمنع شيئًا. */
  warn: boolean;
}

/** أسطر الرصيد المستحق لكل عملة بترتيب العملات، مع علم التنبيه. الصفر والدائن لا يظهران هنا. */
export function balanceLines(
  dues: readonly { currency: Currency; dueMinor: number }[],
  thresholds: BalanceWarningThresholds,
): BalanceLine[] {
  const lines: BalanceLine[] = [];
  for (const currency of CURRENCIES) {
    const dueMinor = dues.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.dueMinor, 0);
    if (dueMinor <= 0) continue;
    const threshold = thresholds[currency];
    lines.push({ currency, dueMinor, warn: threshold !== undefined && dueMinor >= threshold });
  }
  return lines;
}

// ─── Slice 3 — بوابة «جاهز للكرسي» ─────────────────────────────────────────

export type GateAction = "call" | "seat";

export type GateDecision =
  | { allow: true; warning: string | null; bypass: boolean }
  | { allow: false; code: "clearance_required" | "emergency_reason_required"; message: string };

export const CLEARANCE_WARNING = "تنبيه: لم تُقَرّ جاهزية المريض بعد — راجع قائمته.";
export const CLEARANCE_REQUIRED_MESSAGE =
  "أقِرّ جاهزية المريض أولًا (الإعداد يمنع النداء قبل الإقرار) — أو أدخله كطوارئ بسببٍ مكتوب.";
export const EMERGENCY_REASON_MESSAGE = "اكتب سبب الطوارئ (ثلاثة أحرف على الأقل) — يُسجَّل في التدقيق.";
export const EMERGENCY_BYPASS_WARNING = "دخول طوارئ قبل الإقرار — سُجّل السبب في التدقيق.";

/** سبب الطوارئ بعد التطبيع: نصٌّ من ثلاثة أحرف فأكثر (يُقصّ عند ٣٠٠)، وإلا null. */
export function normalizeEmergencyReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim().slice(0, 300);
  return reason.length >= 3 ? reason : null;
}

/**
 * حكم البوابة.
 *
 * - مُقَرّ ⇒ يمرّ بلا تحذير.
 * - إجلاس من «نُودي»: النداء نفسه مرّ من البوابة (إقرارًا أو تحذيرًا أو طوارئ) ⇒ لا منع ثانٍ
 *   ولا سؤال ثانٍ عن سبب الطوارئ؛ يبقى التحذير إن لم يُقَرّ.
 * - الإعداد مغلق (الافتراضي) ⇒ يمرّ مع تحذيرٍ نصّي — صفر نقرات إضافية.
 * - الإعداد مفعَّل ⇒ يُرفض، إلا طوارئ بسببٍ مكتوب فتمرّ ويُدقَّق التجاوز.
 */
export function clearanceGate(input: {
  cleared: boolean;
  requireClearance: boolean;
  action: GateAction;
  fromStatus: string | null;
  emergency: boolean;
  emergencyReason: string | null;
}): GateDecision {
  if (input.cleared) return { allow: true, warning: null, bypass: false };
  if (input.action === "seat" && input.fromStatus === "called") {
    return { allow: true, warning: CLEARANCE_WARNING, bypass: false };
  }
  if (!input.requireClearance) return { allow: true, warning: CLEARANCE_WARNING, bypass: false };
  if (input.emergency || input.emergencyReason !== null) {
    if (input.emergencyReason === null) {
      return { allow: false, code: "emergency_reason_required", message: EMERGENCY_REASON_MESSAGE };
    }
    return { allow: true, warning: EMERGENCY_BYPASS_WARNING, bypass: true };
  }
  return { allow: false, code: "clearance_required", message: CLEARANCE_REQUIRED_MESSAGE };
}
