/**
 * قواعد المراسلة — منطق صرف قابل للاختبار بلا قاعدة.
 *
 * الرسائل في عيادةٍ صغيرة لا تحتاج خادم دردشة: قاعدة واحدة، واستطلاعًا كل ثوانٍ،
 * وقواعد تحدٍّ صارمة تُفحص هنا قبل أن تلمس القاعدة. حدود الصوت مبنية على واقع
 * الاستخدام: ملاحظة صوتية بين طاقم العيادة نادرًا تتجاوز الدقيقة، ودقيقتان حدٌّ
 * أعلى يحمي القاعدة من ملفات ضخمة بلا أن يقطع كلام أحد.
 */

/** أقصى طول للنص — رسالة لا مقال. */
export const MAX_TEXT_LENGTH = 4000;

/** أقصى حجم للصوت بعد فكّ Base64 — نحو 2.4 ميغابايت. */
export const MAX_VOICE_BYTES = 2_500_000;

/** أقصى مدة تسجيل — دقيقتان. */
export const MAX_VOICE_MS = 120_000;

/** أنواع الصوت المقبولة: ما تسجّله المتصفحات وتشغّله هي الأخرى. */
const VOICE_MIME_STEMS = [
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/aac",
  "audio/x-m4a",
  "audio/mp3",
] as const;

/**
 * تطبيع نوع الصوت: أحرف صغيرة وبلا لواحق الترميز.
 *
 * المتصفحات ترسل `audio/webm;codecs=opus` وتشتغل الترميزات كلها بمشغّل واحد،
 * فالمقارنة على الجذر وحده تمنع رفض تسجيلٍ صالحٍ لاختلاف لاحقة.
 */
export function normalizeVoiceMime(mime: string): string {
  return mime.trim().toLowerCase().split(";")[0];
}

export function isAllowedVoiceMime(mime: string): boolean {
  const normalized = normalizeVoiceMime(mime);
  return (VOICE_MIME_STEMS as readonly string[]).includes(normalized);
}

/** Base64 صالح: حروف الأبجدية فقط وطول من مضاعفات الأربعة. */
export function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export type MessageTargetType = "user" | "patient" | "staff_all";

export interface MessageTarget {
  type: MessageTargetType;
  id?: number;
}

/**
 * قراءة جهة الرسالة من جسم الطلب.
 *
 * يقبل `{type: "user", id: 3}` و`{type: "patient", id: 7}` و`{type: "staff_all"}`.
 * ما عدا ذلك — جهة بلا رقم، أو نوع غريب — يُرفض هنا لا في القاعدة.
 */
export function parseMessageTarget(input: unknown): MessageTarget | null {
  if (typeof input === "string") {
    if (input === "staff_all") return { type: "staff_all" };
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const type = source.type;
  if (type === "staff_all") return { type: "staff_all" };
  if (type === "user" || type === "patient") {
    const id = Number(source.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { type, id };
  }
  return null;
}

export interface NormalizedOutgoingMessage {
  target: MessageTarget;
  kind: "text" | "voice";
  body: string | null;
  voiceMime: string | null;
  voiceData: string | null;
  voiceMs: number | null;
}

export type OutgoingMessageResult =
  | { ok: true; value: NormalizedOutgoingMessage }
  | { ok: false; message: string };

/**
 * تحدي رسالة صادرة — نصية كانت أم صوتية.
 *
 * كل قاعدة تُعاد برسالة عربية يفهمها من يقرأ الشاشة، فحدودٌ صامتة أو رمز خطأ
 * إنجليزي لا معنى له على مكتب استقبال.
 */
export function validateOutgoingMessage(
  target: MessageTarget,
  input: Record<string, unknown>,
): OutgoingMessageResult {
  const kind = input.kind === "voice" ? "voice" : "text";

  if (kind === "text") {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) return { ok: false, message: "اكتب نص الرسالة." };
    if (body.length > MAX_TEXT_LENGTH) {
      return { ok: false, message: "الرسالة أطول من الحد المسموح (4000 حرف)." };
    }
    return { ok: true, value: { target, kind, body, voiceMime: null, voiceData: null, voiceMs: null } };
  }

  const voiceMime = typeof input.voiceMime === "string" ? input.voiceMime : "";
  if (!isAllowedVoiceMime(voiceMime)) {
    return { ok: false, message: "نوع التسجيل الصوتي غير مدعوم." };
  }
  const voiceData = typeof input.voiceData === "string" ? input.voiceData : "";
  if (!isBase64(voiceData)) {
    return { ok: false, message: "تسجيل صوتي غير صالح." };
  }
  const decodedBytes = Math.floor((voiceData.length * 3) / 4);
  if (decodedBytes > MAX_VOICE_BYTES) {
    return { ok: false, message: "التسجيل أطول من الحد المسموح — أرسله على جزأين." };
  }
  const voiceMsRaw = Number(input.voiceMs);
  if (!Number.isFinite(voiceMsRaw) || voiceMsRaw <= 0) {
    return { ok: false, message: "مدة التسجيل غير صالحة." };
  }
  const voiceMs = Math.min(Math.round(voiceMsRaw), MAX_VOICE_MS);
  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : null;

  return {
    ok: true,
    value: { target, kind, body, voiceMime: normalizeVoiceMime(voiceMime), voiceData, voiceMs },
  };
}

/** مدة صوتية مقروءة: 1:05 — أرقام موحّدة فتتسق في فقاعة الرسالة. */
export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** معاينة نصية لفقاعة المحادثة: الرسائل الصوتية مدتها لا جسمها. */
export function messagePreview(kind: "text" | "voice", body: string | null, voiceMs: number | null): string {
  if (kind === "voice") return `رسالة صوتية ${formatVoiceDuration(voiceMs ?? 0)}`;
  return (body ?? "").replace(/\s+/g, " ").slice(0, 60);
}
