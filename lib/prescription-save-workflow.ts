/**
 * منطق سير العمل عند حفظ الوصفة وطباعتها (Prescription Save Workflow)
 * — مراجعة P0 المستقلة، الجولة الثانية، Blocker B.
 *
 * الخادم هو المرجع النهائي للسلامة، وهذه الدالة النقية تترجم ردّ الخادم إلى
 * الخطوة التالية للواجهة — فلا تتخذ الواجهة قرار طباعةٍ رسميةٍ أو سقوطٍ إلى
 * مسودةٍ إلا وفق ما قاله الخادم، لا وفق فحصٍ محليٍّ عندها (client-only
 * hasCriticalAlert لا يُعتمد عليه):
 *
 *   201 + id
 *     ⇒ officialPrint — الوثيقة الرسمية تُطبع من المحفوظ.
 *   409 + safetyAlerts (تعارض دوائي حرج)
 *     ⇒ criticalBlock — **توقّف تام**: لا طباعة رسمية، ولا سقوط تلقائي إلى
 *       مسودة. السبب يُعرض للطبيب، والمسودة غير المعتمدة زرٌّ منفصلٌ صريح.
 *   200 + requiresAcknowledgement (تحذيرات غير حرجة)
 *     ⇒ awaitAcknowledgement — لا حفظ ولا طباعة رسمية بعد: عرض التحذيرات،
 *       ثم إقرارٌ صريحٌ من الطبيب، ثم إعادة الإرسال برمز الإقرار.
 *   409 + ackRejected
 *     ⇒ acknowledgementRejected — تغيّرت الوصفة بعد الإقرار (أو الرمز لا
 *       يخصّ المستخدم): الإقرار القديم باطل ويُعاد العرض من جديد.
 *   ما عدا ذلك (500/شبكة/انتهاء جلسة)
 *     ⇒ draftFallback — الفشل غير الحرج لا يحرم المريض وصفته: تُطبع مسودة
 *       موسومة «غير معتمدة» مع إظهار سبب الفشل — وهو ليس بديلًا بعد منعٍ حرج.
 */

import type { DrugSafetyAlert } from "./medication-safety";

export type PrescriptionSaveOutcome =
  | { kind: "officialPrint"; prescriptionId: number; safetyWarnings: DrugSafetyAlert[] }
  | { kind: "criticalBlock"; message: string; safetyAlerts: DrugSafetyAlert[] }
  | { kind: "awaitAcknowledgement"; safetyWarnings: DrugSafetyAlert[]; acknowledgementToken: string; message?: string }
  | { kind: "acknowledgementRejected"; message: string; ackReason?: string }
  | { kind: "draftFallback"; reason: string };

function asAlerts(value: unknown): DrugSafetyAlert[] {
  return Array.isArray(value) ? (value as DrugSafetyAlert[]) : [];
}

function asMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * يترجم (status, payload) من POST /api/prescriptions إلى الخطوة التالية.
 * عمدًا لا تفحص حالة العميل إطلاقًا: كلمة الخادم هي الفيصل.
 */
export function interpretPrescriptionSaveResponse(
  status: number,
  payload: unknown,
): PrescriptionSaveOutcome {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

  /* ١) نجاح: الوثيقة محفوظة — الطباعة الرسمية من id المحفوظ. */
  if (status === 201 && Number.isInteger(body.id) && (body.id as number) > 0) {
    return {
      kind: "officialPrint",
      prescriptionId: body.id as number,
      safetyWarnings: asAlerts(body.safetyWarnings),
    };
  }

  /* ٢) منعٌ حرج: توقّف تام — لا رسمية ولا مسودة تلقائية. */
  if (status === 409 && Array.isArray(body.safetyAlerts) && asAlerts(body.safetyAlerts).length > 0) {
    return {
      kind: "criticalBlock",
      message: asMessage(body.message, "تعارض دوائي حرج — لا تُحفظ الوصفة."),
      safetyAlerts: asAlerts(body.safetyAlerts),
    };
  }

  /* ٣) إقرارٌ باطل: الوصفة تغيّرت بعد إقرار التحذيرات (أو رمزٌ لا يخصّك). */
  if (status === 409 && body.ackRejected === true) {
    return {
      kind: "acknowledgementRejected",
      message: asMessage(body.message, "الإقرار لا يطابق الوصفة/التحذيرات الحالية — راجعها من جديد."),
      ackReason: typeof body.ackReason === "string" ? body.ackReason : undefined,
    };
  }

  /* ٤) تحذيرات غير حرجة: عرضٌ وإقرارٌ قبل الحفظ — لا طباعة الآن. */
  if (
    (status === 200 || status === 202) &&
    body.requiresAcknowledgement === true &&
    typeof body.acknowledgementToken === "string" &&
    body.acknowledgementToken.length > 0
  ) {
    return {
      kind: "awaitAcknowledgement",
      safetyWarnings: asAlerts(body.safetyWarnings),
      acknowledgementToken: body.acknowledgementToken,
      message: typeof body.message === "string" && body.message.trim().length > 0
        ? body.message
        : undefined,
    };
  }

  /* ٥) فشلٌ غير حرج: مسودةٌ معلنة مع سببٍ ظاهر — ليست بديلًا بعد منعٍ حرج. */
  return {
    kind: "draftFallback",
    reason: asMessage(body.message, "تعذّر حفظ الوصفة كوثيقة — ستُطبع بالطريقة السريعة."),
  };
}
