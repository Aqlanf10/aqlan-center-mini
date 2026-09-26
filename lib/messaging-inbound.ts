/**
 * (MSG-2) الردود الواردة — واتساب للأعمال وبوابة الرسائل النصية — تدخل سجل الرسائل
 * نفسه (`direction = in`) وتظهر في وحدة الرسائل للرد عليها.
 *
 * منطقٌ خالص يُختبر بلا شبكة ولا قاعدة:
 * - **واتساب**: رسائل Meta موقّعةٌ بـ `X-Hub-Signature-256` (HMAC-SHA256 للجسم الخام بـ App Secret)
 *   — تُتحقق بزمنٍ ثابت قبل قراءة أي شيء؛ وغير الموقّع أو المزوّر يُرفض. وتحقق الاشتراك
 *   (GET) برمز التحقق الذي ولّده النظام.
 * - **الرسائل النصية**: البوابة تضرب عنوانًا يحمل مفتاح الاستقبال الذي ولّده النظام؛ وأسماء
 *   الحقول تختلف بين البوابات فتُقبل الشائعة منها (from/sender/msisdn… و text/message/body…).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // مقارنةٌ بطولٍ ثابت ثم رفض — لا يكشف الطول وحده.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** هل توقيع Meta صحيح لهذا الجسم الخام؟ */
export function validMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  return constantTimeEqual(header.trim(), expected);
}

export interface InboundMessage {
  from: string;
  providerMessageId: string | null;
  body: string;
  at: Date | null;
}

export interface StatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: "صورة", audio: "رسالة صوتية", video: "مقطع فيديو", document: "مستند", sticker: "ملصق",
  location: "موقع", contacts: "جهة اتصال", reaction: "تفاعل",
};

/** رسائل وتحديثات حالة من جسم webhook واتساب — يتجاهل ما لا يعرفه ولا ينهار عليه. */
export function parseWhatsAppWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return { messages, statuses };
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value ?? {};
      for (const raw of Array.isArray(value.messages) ? value.messages : []) {
        const message = raw as Record<string, unknown>;
        const from = typeof message.from === "string" ? message.from.replace(/\D/g, "") : "";
        if (!from) continue;
        const type = typeof message.type === "string" ? message.type : "text";
        const text = type === "text"
          ? String((message.text as { body?: unknown } | undefined)?.body ?? "")
          : type === "button"
            ? String((message.button as { text?: unknown } | undefined)?.text ?? "")
            : `[${MEDIA_LABEL[type] ?? type}]`;
        const seconds = Number(message.timestamp);
        messages.push({
          from,
          providerMessageId: typeof message.id === "string" ? message.id : null,
          body: text.slice(0, 5000) || "[رسالة فارغة]",
          at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null,
        });
      }
      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = raw as Record<string, unknown>;
        const kind = status.status;
        if (typeof status.id !== "string" || (kind !== "sent" && kind !== "delivered" && kind !== "read" && kind !== "failed")) continue;
        const firstError = Array.isArray(status.errors) ? (status.errors[0] as { code?: unknown } | undefined) : undefined;
        statuses.push({
          providerMessageId: status.id,
          status: kind,
          error: kind === "failed" ? `لم تُسلَّم الرسالة لدى واتساب${typeof firstError?.code === "number" ? ` (رمز ${firstError.code})` : ""}.` : null,
        });
      }
    }
  }
  return { messages, statuses };
}

const FROM_KEYS = ["from", "sender", "msisdn", "phone", "mobile", "number", "source", "originator"];
const TEXT_KEYS = ["text", "message", "body", "content", "msg", "sms"];
const ID_KEYS = ["id", "message_id", "messageId", "msgid", "sms_id"];

/** رسالة واردة من بوابة الرسائل النصية بأسماء حقولها الشائعة — أو null إن نقص الرقم أو النص. */
export function parseSmsInbound(fields: Record<string, unknown>): InboundMessage | null {
  const pick = (keys: string[]) => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  };
  const from = pick(FROM_KEYS).replace(/\D/g, "");
  const body = pick(TEXT_KEYS);
  if (!from || !body) return null;
  return { from, providerMessageId: pick(ID_KEYS) || null, body: body.slice(0, 5000), at: null };
}
