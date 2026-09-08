/**
 * ربط إقرار قراءة تحذيرات السلامة الدوائية بالوصفة **وبالتحذيرات نفسها**
 * (Safety Acknowledgement Binding) — مراجعة P0 المستقلة، الجولة الثالثة،
 * المانع الأخير.
 *
 * الخادم هو المرجع النهائي للسلامة: عند وجود تحذيرات غير حرجة يعيد الخادم
 * **عرضًا** لا حفظًا، مع رمز إقرارٍ محسوب على الخادم (HMAC-SHA256 بسّرٍ لا
 * يعرفه العميل) فوق ثلاثة أشياء مجموعة:
 *
 * ١) **المستخدم** (username) — لا يستخدم رمزُ مستخدمٍ آخر.
 * ٢) **المحتوى الكانوني الدقيق للوصفة** (canonicalPrescriptionForAck):
 *    المريض والزيارة والتشخيص والملاحظات واللغة والأدوية بكل حقولها —
 *    فتغيير دواءٍ أو جرعة بعد الإقرار يُبطل الرمز.
 * ٣) **بصمة التحذيرات التي شاهدها الطبيب وقت الإقرار** (warning
 *    fingerprint): تمثيلٌ كانوني مرتَّب لا يعتمد على ترتيب النتائج لكل
 *    تحذير (هوية القاعدة + الخطورة + الدواء + النص)، مُختزَل SHA-256.
 *    فلو تغيّر ملف المريض بين المعاينة والإقرار وتغيّرت التحذيرات (إضافة/
 *    حذف/تغيّر خطورة أو قاعدة) بطل الرمز — لأن الطبيب أقرّ تحذيراتٍ لم
 *    يعد يُعرض عليه حفظُ وصفةٍ عليها، وعليه إقرار التحذيرات الجديدة.
 *
 * وللرمز عمرٌ قصير (TTL عشر دقائق) بـissuedAt/expiresAt داخل الحمولة
 * الموقَّعة، فلا تبقى موافقة سريرية قديمة صالحة بلا نهاية.
 *
 * صيغة الرمز: `base64url(payloadJson).base64url(hmac)` حيث
 * payload = { v, u, f, iat, exp } وHMAC فوق الحمولة + التمثيل الكانوني
 * للوصفة. الرمز قديم الصيغة (v1: توقيع مجرّد بلا حمولة) يُرفض
 * صراحةً — فقد كان غير مربوط بالتحذيرات ولا بعمر.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrescriptionDraft } from "./prescription";
import type { DrugSafetyAlert } from "./medication-safety";

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

/** عمر رمز الإقرار: ١٠ دقائق (ضمن نطاق ٥–١٠ دقائق الذي حدّدته المراجعة). */
export const SAFETY_ACK_TTL_MS = 10 * 60 * 1000;

/** إصدار صيغة الرمز — v1 (توقيع مجرّد) لم يكن يربط التحذيرات فيُرفض. */
const ACK_TOKEN_VERSION = 2;

/** التمثيل الكانوني للوصفة — بعد تنقية checkPrescriptionDraft نفسها، فالربط
 * على ما سيُحفَظ فعلًا لا على ما أرسله العميل خامًا: أي تغيير في دواءٍ أو
 * جرعة أو تعليمة يغيّر التمثيل ويُبطل الرمز. */
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

/**
 * التمثيل الكانوني لمجموعة التحذيرات — **مرتَّبًا بمفتاح ثابت** (هوية
 * التحذير ثم الدواء) فلا يتغيّر التمثيل بتغيّر ترتيب نتائج التقييم:
 * بصمة نفس التحذيرات واحدة سواء رُتِّبت critical-first (كما يعيدها
 * المحرك) أو بغير ذلك.
 *
 * كل تحذير يمثَّل بحقول هويته السريرية الثابتة:
 *   [id (هوية القاعدة+الدواء), contraindicatedRiskId (القاعدة/الخطر),
 *    medicationName, severity, title, message, suggestedAlternative]
 * فأي إضافة أو حذف تحذير، أو تغيّر خطورة أو قاعدة أو نص، يغيّر التمثيل —
 * وهذا المطلوب: الطبيب يقرّ ما رأى، حرفيًا.
 */
export function canonicalWarningsForFingerprint(warnings: DrugSafetyAlert[]): string {
  const entries = warnings.map((w) => [
    w.id,
    w.contraindicatedRiskId,
    w.medicationName,
    w.severity,
    w.title,
    w.message,
    w.suggestedAlternative ?? null,
  ]);
  entries.sort((a, b) => {
    const ka = `${a[0]}\u0000${a[2]}`;
    const kb = `${b[0]}\u0000${b[2]}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return JSON.stringify(entries);
}

/**
 * بصمة التحذيرات: SHA-256 فوق التمثيل الكانوني المرتَّب — سلسلة hex
 * ثابتة الطول (64) تُربط داخل الرمز الموقَّع وتُقارن عند الإقرار.
 */
export function warningFingerprint(warnings: DrugSafetyAlert[]): string {
  return createHash("sha256").update(canonicalWarningsForFingerprint(warnings)).digest("hex");
}

interface AckTokenPayload {
  v: number;
  u: string;
  f: string;
  iat: number;
  exp: number;
}

function computeSignature(payloadB64: string, draft: PrescriptionDraft): string {
  const payload = `${payloadB64}\n${canonicalPrescriptionForAck(draft)}`;
  return createHmac("sha256", acknowledgementSecret()).update(payload).digest("base64url");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** يبني رمز الإقرار الذي يُعاد مع عرض التحذيرات — لمستخدمٍ ووصفةٍ
 *  وتحذيراتٍ بعينها، بصلاحية عشر دقائق. `now` قابل للحقن للاختبارات. */
export function buildSafetyAcknowledgementToken(input: {
  username: string;
  draft: PrescriptionDraft;
  warnings: DrugSafetyAlert[];
  now?: number;
}): string {
  const issuedAt = input.now ?? Date.now();
  const payload: AckTokenPayload = {
    v: ACK_TOKEN_VERSION,
    u: input.username,
    f: warningFingerprint(input.warnings),
    iat: issuedAt,
    exp: issuedAt + SAFETY_ACK_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${computeSignature(payloadB64, input.draft)}`;
}

/** أسباب رفض رمز الإقرار — تُعاد للطبيب وللسجلات على السواء. */
export type SafetyAckFailure =
  | "malformed"
  | "bad_signature"
  | "wrong_user"
  | "expired"
  | "warning_fingerprint_changed";

export type SafetyAckVerdict = { ok: true } | { ok: false; failure: SafetyAckFailure };

/**
 * يتحقق أن الرمز صادرٌ فعلًا عن خادمنا (التوقيع)، للمستخدم نفسه، وللوصفة
 * نفسها بمحتواها الكانوني الحرفي، ولتحذيراتٍ بصمتها تطابق ما وُقّع وقت
 * العرض، وأنه لم ينتهِ (TTL). أي فارق ⇒ { ok: false } مع سبب الرفض.
 *
 * ترتيب الفحوص مقصود: البنية، ثم التوقيع (يشمل تغيّر الوصفة/التزوير)، ثم
 * المستخدم، ثم الانتهاء، ثم بصمة التحذيرات — فلا يُكشف أي فارق في البصمة
 * إلا لرمزٍ سليم البنية والتوقيع والهوية والصلاحية.
 */
export function verifySafetyAcknowledgementToken(
  token: unknown,
  input: {
    username: string;
    draft: PrescriptionDraft;
    warnings: DrugSafetyAlert[];
    now?: number;
  },
): SafetyAckVerdict {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
    return { ok: false, failure: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1 || token.lastIndexOf(".") !== dot) {
    /* ليست صيغة body.sig (نقطة في الطرف أو أكثر من نقطة) — تشمل رموز v1
     * القديمة (توقيعًا مجرّدًا بلا حمولة). */
    return { ok: false, failure: "malformed" };
  }
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, failure: "malformed" };
  }
  const payload = parsed as Partial<AckTokenPayload> | null;
  if (
    !payload ||
    payload.v !== ACK_TOKEN_VERSION ||
    typeof payload.u !== "string" ||
    payload.u.length === 0 ||
    typeof payload.f !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.f) ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > SAFETY_ACK_TTL_MS
  ) {
    return { ok: false, failure: "malformed" };
  }

  /* التوقيع: يغطي الحمولة كلها (المستخدم/البصمة/الصلاحية) + التمثيل
   * الكانوني للوصفة الحالية — فأي تغيير دواء أو جرعة أو تزويرٍ يُسقطه. */
  if (!timingSafeEqualStrings(signature, computeSignature(payloadB64, input.draft))) {
    return { ok: false, failure: "bad_signature" };
  }
  if (payload.u !== input.username) {
    return { ok: false, failure: "wrong_user" };
  }
  const now = input.now ?? Date.now();
  if (now >= payload.exp) {
    return { ok: false, failure: "expired" };
  }
  /* بصمة التحذيرات الحالية (المُعاد حسابها من الملف وقت الإقرار) يجب أن
   * تطابق بصمة ما شاهده الطبيب ووقّعه الخادم وقت العرض — حرفيًا. */
  if (!timingSafeEqualStrings(payload.f, warningFingerprint(input.warnings))) {
    return { ok: false, failure: "warning_fingerprint_changed" };
  }
  return { ok: true };
}
