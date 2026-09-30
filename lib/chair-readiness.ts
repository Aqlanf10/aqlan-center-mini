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
