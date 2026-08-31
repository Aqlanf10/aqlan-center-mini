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

/** أقصى حجم للمرفق بعد فكّ Base64 — عشرة ميغابايت. */
export const MAX_FILE_BYTES = 10_000_000;

/** أقصى طول لاسم الملف المعروض. */
export const MAX_FILE_NAME_LENGTH = 120;

/** أنواع المرفقات المقبولة: صور المتصفحات كلها وPDF — لا SVG ولا نصوص تنفيذ. */
export const ALLOWED_FILE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

export function isAllowedFileMime(mime: string): boolean {
  return (ALLOWED_FILE_MIMES as readonly string[]).includes(mime.trim().toLowerCase());
}

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

export type MessageTargetType = "user" | "patient" | "staff_all" | "staff_broadcast";

export interface MessageTarget {
  type: MessageTargetType;
  id?: number;
}

/**
 * قراءة جهة الرسالة من جسم الطلب.
 *
 * يقبل `{type: "user", id: 3}` و`{type: "patient", id: 7}` و`{type: "staff_all"}`
 * (صندوق الطاقم — من البوابة) و`{type: "staff_broadcast"}` (رسالة جماعية — من
 * الطاقم). ما عدا ذلك — جهة بلا رقم، أو نوع غريب — يُرفض هنا لا في القاعدة.
 */
export function parseMessageTarget(input: unknown): MessageTarget | null {
  if (typeof input === "string") {
    if (input === "staff_all") return { type: "staff_all" };
    if (input === "staff_broadcast") return { type: "staff_broadcast" };
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const type = source.type;
  if (type === "staff_all") return { type: "staff_all" };
  if (type === "staff_broadcast") return { type: "staff_broadcast" };
  if (type === "user" || type === "patient") {
    const id = Number(source.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { type, id };
  }
  return null;
}

/**
 * علامة العاجلة من جسم الطلب — الحقيقة الصريحة وحدها تُشعلها.
 *
 * رسالة المريض العاجلة ترفع صوت العيادة كلها: نغمة أصرخ وشارة حمراء وبانر في
 * القشرة. ولأن هذا الضجيج مكلّف، لا يُقبله إلا طلبٌ يقول «true» صراحةً — لا
 * «yes» ولا نصٍّ يمرّ سليمًا فيتحول عاديُّ الرسائل كلها إلى نداء استغاثة.
 */
export function parseUrgentFlag(input: unknown): boolean {
  return input === true;
}

/**
 * معرّف الرسالة المردود عليها — رقم صحيح موجب أو لا ردّ أصلًا.
 *
 * الردّ اقتباسٌ يربط الرسالة بأختها لا إعادة كتابتها، والمعرّف الغريب (نص أو
 * سالب أو كسر) يُهمَل بدل أن يُرفض الطلب كله — الردّ زينة والنصّ أساس.
 */
export function parseReplyToId(input: unknown): number | null {
  const id = Number(input);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export interface NormalizedOutgoingMessage {
  target: MessageTarget;
  kind: "text" | "voice" | "file";
  body: string | null;
  voiceMime: string | null;
  voiceData: string | null;
  voiceMs: number | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  fileData: string | null;
  /** علامة العاجلة — للمرضى من البوابة حصرًا. */
  urgent: boolean;
  /** الرسالة التي يُردّ عليها — معرّف رقمي أو غياب. */
  replyToId: number | null;
}

export type OutgoingMessageResult =
  | { ok: true; value: NormalizedOutgoingMessage }
  | { ok: false; message: string };

/**
 * تحدي رسالة صادرة — نصية كانت أم صوتية أم مرفقًا.
 *
 * كل قاعدة تُعاد برسالة عربية يفهمها من يقرأ الشاشة، فحدودٌ صامتة أو رمز خطأ
 * إنجليزي لا معنى له على مكتب استقبال.
 */
export function validateOutgoingMessage(
  target: MessageTarget,
  input: Record<string, unknown>,
): OutgoingMessageResult {
  const kind: "text" | "voice" | "file" =
    input.kind === "voice" ? "voice" : input.kind === "file" ? "file" : "text";
  const urgent = parseUrgentFlag(input.urgent);
  const replyToId = parseReplyToId(input.replyTo);

  if (kind === "text") {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) return { ok: false, message: "اكتب نص الرسالة." };
    if (body.length > MAX_TEXT_LENGTH) {
      return { ok: false, message: "الرسالة أطول من الحد المسموح (4000 حرف)." };
    }
    return {
      ok: true,
      value: {
        target, kind, body,
        voiceMime: null, voiceData: null, voiceMs: null,
        fileName: null, fileMime: null, fileSize: null, fileData: null,
        urgent, replyToId,
      },
    };
  }

  if (kind === "file") {
    const fileVerdict = validateOutgoingFile(target, input);
    if (!fileVerdict.ok) return fileVerdict;
    return {
      ok: true,
      value: { ...fileVerdict.value, urgent, replyToId },
    };
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
    value: {
      target, kind: "voice", body,
      voiceMime: normalizeVoiceMime(voiceMime), voiceData, voiceMs,
      fileName: null, fileMime: null, fileSize: null, fileData: null,
      urgent: false, replyToId: null,
    },
  };
}

/**
 * تحدي المرفق — أمن البوابة يقف هنا.
 *
 * الملفات من العالم الخارجي، والثقة بالنوع المعلن عمّالة خائنة: `evil.pdf.jpg`
 * ونصٌّ تنفيذي باسم صورة. ثلاثة أسوار:
 *  ١) قائمة أنواع مغلقة (صور وPDF فقط).
 *  ٢) اسم ملف نظّيف — بلا مسارات ولا محارف تحكم، فالاسم يعود في رؤوس التنزيل.
 *  ٣) **البصمة السحرية**: بايتات الملف الأولى يجب أن تطابق نوعه المعلن، فما
 *     يُدّعى صورةً وهو تنفيذٌ يُرفض مهما غيّر ملحقه.
 */
function validateOutgoingFile(
  target: MessageTarget,
  input: Record<string, unknown>,
): OutgoingMessageResult {
  const fileMime = typeof input.fileMime === "string" ? input.fileMime.trim().toLowerCase() : "";
  if (!isAllowedFileMime(fileMime)) {
    return { ok: false, message: "نوع الملف غير مدعوم — الصور وPDF فقط." };
  }

  const fileName = sanitizeFileName(typeof input.fileName === "string" ? input.fileName : "");
  if (!fileName) {
    return { ok: false, message: "اسم الملف غير صالح." };
  }

  const fileData = typeof input.fileData === "string" ? input.fileData : "";
  if (!isBase64(fileData)) {
    return { ok: false, message: "ملف غير صالح." };
  }
  const decodedBytes = Math.floor((fileData.length * 3) / 4);
  if (decodedBytes > MAX_FILE_BYTES) {
    return { ok: false, message: "الملف أكبر من الحد المسموح (10 ميغابايت)." };
  }

  const declaredSize = Number(input.fileSize);
  const fileSize = Number.isInteger(declaredSize) && declaredSize > 0
    ? Math.min(declaredSize, MAX_FILE_BYTES) : decodedBytes;

  if (!fileMatchesMagicBytes(fileMime, fileData)) {
    return { ok: false, message: "محتوى الملف لا يطابق نوعه المعلن." };
  }

  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : null;

  return {
    ok: true,
    value: {
      target, kind: "file", body,
      voiceMime: null, voiceData: null, voiceMs: null,
      fileName, fileMime, fileSize, fileData,
      urgent: false, replyToId: null,
    },
  };
}

/**
 * اسم ملف آمن للعرض ورؤوس التنزيل: بلا مسارات ولا محارف تحكم ولا طول مفرط.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  if (!cleaned) return "";
  return cleaned.length > MAX_FILE_NAME_LENGTH
    ? cleaned.slice(cleaned.length - MAX_FILE_NAME_LENGTH) : cleaned;
}

/**
 * البصمة السحرية — بايتات الملف الأولى تشهد لنوعه.
 *
 * خداع الامتداد أسهل ما يكون؛ خداع البايتات الأولى لصيغةٍ مضغوطةٍ بكاملها يحتاج
 * بناء الملف نفسه. لكل نوعٍ موقّعه الثابت في أول بايتاته، والمطابقة شرطُ قبول.
 */
export function fileMatchesMagicBytes(mime: string, base64: string): boolean {
  let prefix: Buffer;
  try {
    prefix = Buffer.from(base64.slice(0, 24), "base64");
  } catch {
    return false;
  }
  if (prefix.length < 4) return false;
  const startsWith = (bytes: number[]) =>
    bytes.length <= prefix.length && bytes.every((byte, index) => prefix[index] === byte);
  const ascii = (text: string, at: number) =>
    prefix.length >= at + text.length && prefix.subarray(at, at + text.length).toString("latin1") === text;

  switch (mime) {
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return ascii("GIF8", 0);
    case "image/webp":
      return ascii("RIFF", 0) && ascii("WEBP", 8);
    case "application/pdf":
      return ascii("%PDF", 0);
    default:
      return false;
  }
}

/** مدة صوتية مقروءة: 1:05 — أرقام موحّدة فتتسق في فقاعة الرسالة. */
export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** معاينة نصية لفقاعة المحادثة: الرسائل الصوتية مدتها والمرفقات أسماؤها. */
export function messagePreview(
  kind: "text" | "voice" | "file",
  body: string | null,
  voiceMs: number | null,
  fileName?: string | null,
  flags?: { deleted?: boolean; urgent?: boolean },
): string {
  const prefix = flags?.urgent ? "🚨 عاجلة · " : "";
  if (flags?.deleted) return `${prefix}رسالة محذوفة`;
  if (kind === "voice") return `${prefix}رسالة صوتية ${formatVoiceDuration(voiceMs ?? 0)}`;
  if (kind === "file") {
    const name = (fileName ?? "").trim();
    return `${prefix}${name ? `مرفق: ${name.slice(0, 40)}` : "مرفق"}`;
  }
  return `${prefix}${(body ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
}

/** حجم مقروء للمرفق: كيلوبايت أو ميغابايت بأرقام موحدة. */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** حد معدل إرسال المريض: رسائل في الساعة — يمنع إغراق صندوق الطاقم. */
export const PORTAL_MESSAGE_HOUR_LIMIT = 30;

export interface MessageEditRequest {
  messageId: number;
  body: string;
}

export type MessageEditResult =
  | { ok: true; value: MessageEditRequest }
  | { ok: false; message: string };

/**
 * تحدي تعديل رسالة نصية — نفس حدود الإرسال بذاتها.
 *
 * التعديل يخصّ الرسائل النصية وحدها: الصوت والمرفق وثيقة قيلت كما قيلت، وتعديل
 * محتواها بعد الإرسال يزوّر ما سمعه الطرف الآخر. والمعرّف رقمٌ صحيح موجب، والنص
 * مقصوص غير فارغ ضمن حدّ الأربعة آلاف.
 */
export function validateMessageEdit(input: Record<string, unknown>): MessageEditResult {
  const messageId = Number(input.id);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return { ok: false, message: "رسالة غير صالحة." };
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return { ok: false, message: "اكتب النص الجديد للرسالة." };
  if (body.length > MAX_TEXT_LENGTH) {
    return { ok: false, message: "الرسالة أطول من الحد المسموح (4000 حرف)." };
  }
  return { ok: true, value: { messageId, body } };
}

/** معرّف رسالة من جسم الطلب أو رابطه — للحذف. */
export function parseMessageId(input: unknown): number | null {
  const id = Number(input);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}
