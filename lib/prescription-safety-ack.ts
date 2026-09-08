/**
 * ربط إقرار قراءة تحذيرات السلامة الدوائية بالوصفة نفسها
 * (Safety Acknowledgement Binding) — مراجعة P0 المستقلة، الجولة الثانية، Blocker B.
 *
 * الخادم هو المرجع النهائي للسلامة: عند وجود تحذيرات غير حرجة يعيد الخادم
 * **عرضًا** لا حفظًا، مع رمز إقرارٍ محسوب على الخادم (HMAC-SHA256 بسّرٍ لا
 * يعرفه العميل) فوق المحتوى الكانوني **الدقيق** للوصفة المُعرضة: المريض
 * والزيارة والتشخيص والملاحظات واللغة والأدوية بكل حقولها.
 *
 * فلا يستطيع العميل:
 * ١) أن يزوّر رمزًا لوصفةٍ أخرى — لا يعرف السرّ.
 * ٢) أن يقرّ تحذيرات وصفةٍ ثم يغيّر الأدوية قبل الحفظ — الرمز لا يطابق
 *    المحتوى الجديد فيُرفض (تغيّرت الوصفة بعد الإقرار ⇒ إقرارٌ باطل).
 * ٣) أن يستخدم رمز مستخدمٍ آخر — اسم المستخدم داخل الحساب.
 *
 * وهذا «hash / confirmation token / equivalent server-side binding» الذي
 * طالب به المراجع: الموافقة مرتبطة بنفس الوصفة والمعاملات حرفيًا.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrescriptionDraft } from "./prescription";

/**
 * سرّ توقيع الإقرار: SESSION_SECRET حيثما ضُبط (الإنتاج)، وإلا مفتاحٌ عشوائيّ
 * لعملية الخادم الحالية — كما في رموز تأكيد أدوات AI (lib/ai-confirmation.ts).
 */
let volatileSecret: string | null = null;
function acknowledgementSecret(): string {
  const envSecret = process.env.SESSION_SECRET;
  if (typeof envSecret === "string" && envSecret.length >= 32) return envSecret;
  if (!volatileSecret) {
    volatileSecret = `rx-safety-ack-dev-${randomUUID()}-${randomUUID()}`;
  }
  return volatileSecret;
}

/**
 * التمثيل الكانوني للوصفة — بعد تنقية checkPrescriptionDraft نفسها، فالربط
 * على ما سيُحفَظ فعلًا لا على ما أرسله العميل خامًا: أي تغيير في دواءٍ أو
 * جرعة أو تعليمة يغيّر التمثيل ويُبطل الرمز.
 */
export function canonicalPrescriptionForAck(draft: PrescriptionDraft): string {
  return JSON.stringify({
    patientId: draft.patientId,
    visitId: draft.visitId,
    diagnosis: draft.diagnosis,
    notes: draft.notes,
    instructionsLang: draft.instructionsLang,
    items: draft.items.map((item) => [
      item.name,
      item.dose,
      item.form,
      item.frequency,
      item.duration,
      item.instructions,
      item.instructionsEn,
    ]),
  });
}

function computeSignature(username: string, draft: PrescriptionDraft): string {
  const payload = `${username}\n${canonicalPrescriptionForAck(draft)}`;
  return createHmac("sha256", acknowledgementSecret()).update(payload).digest("base64url");
}

/** يبني رمز الإقرار الذي يُعاد مع عرض التحذيرات — لمستخدمٍ ووصفةٍ بعينها. */
export function buildSafetyAcknowledgementToken(input: {
  username: string;
  draft: PrescriptionDraft;
}): string {
  return computeSignature(input.username, input.draft);
}

/**
 * يتحقق أن الرمز صادرٌ فعلًا عن خادمنا للمستخدم نفسه وللوصفة نفسها
 * (بمحتواها الكانوني الحرفي). أي فارق ⇒ false.
 */
export function verifySafetyAcknowledgementToken(
  token: unknown,
  input: { username: string; draft: PrescriptionDraft },
): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return false;
  const expected = computeSignature(input.username, input.draft);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
