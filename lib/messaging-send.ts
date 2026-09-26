/**
 * (MSG-1) إرسال رسالةٍ عبر قناةٍ خارجية — واتساب أو رسالة نصية أو بريد — وتسجيلها.
 *
 * «تُرسل أو يُقال إنها لم تُرسل»: كل محاولةٍ تُسجَّل في `message_deliveries` بحالتها
 * (أُرسلت/فشلت) وسببها بالعربية، والقناة المعطَّلة أو غير المهيَّأة تُرفض برسالة واضحة.
 * والسرّ يُفكّ في الذاكرة لحظة الإرسال ولا يُكتب في سجلٍّ ولا ردّ.
 *
 * التبعيات محقونة (القاعدة والشبكة) — فيُختبر كل مسارٍ بلا اتصالٍ حقيقي.
 */
import {
  buildSmsRequest, isEmail, smsRecipient, smsResponseOk,
  type Channel, type ChannelConfigMap, type EmailChannelConfig, type SmsChannelConfig, type WhatsAppChannelConfig,
} from "./messaging-channels";
import { toWhatsAppNumber } from "./reminders";
import { sendMail, type SmtpTransport } from "./smtp-client";
import { sendWhatsAppText } from "./whatsapp-cloud";

export interface OutboundMessage {
  channel: Channel;
  /** رقم الجوال (واتساب/نصية) أو البريد. */
  to: string;
  subject?: string | null;
  body: string;
  patientId: number | null;
  purpose: "manual" | "test" | "reply" | "reminder";
  actor: string;
}

export type OutboundResult =
  | { ok: true; deliveryId: number | null }
  | { ok: false; message: string; deliveryId: number | null; status: 400 | 409 | 502 };

export interface OutboundDeps {
  channel(channel: Channel): Promise<{
    view: { enabled: boolean; config: ChannelConfigMap[Channel] };
    secret: string | null;
  }>;
  record(entry: {
    channel: Channel; patientId: number | null; counterpart: string; subject: string | null; body: string;
    purpose: string; status: "sent" | "failed"; providerMessageId: string | null; error: string | null; createdBy: string;
  }): Promise<number | null>;
  fetchImpl?: typeof fetch;
  smtpTransport?: SmtpTransport;
}

const NOT_READY: Record<Channel, string> = {
  whatsapp: "قناة واتساب للأعمال غير مفعّلة أو غير مهيّأة — اضبطها من الإعدادات ← الرسائل.",
  sms: "قناة الرسائل النصية غير مفعّلة أو غير مهيّأة — اضبطها من الإعدادات ← الرسائل.",
  email: "قناة البريد غير مفعّلة أو غير مهيّأة — اضبطها من الإعدادات ← الرسائل.",
};

export async function sendOutbound(message: OutboundMessage, deps: OutboundDeps): Promise<OutboundResult> {
  const body = message.body.trim();
  if (!body) return { ok: false, message: "اكتب نص الرسالة.", deliveryId: null, status: 400 };
  if (body.length > 4000) return { ok: false, message: "الرسالة أطول من ٤٠٠٠ حرف.", deliveryId: null, status: 400 };

  const { view, secret } = await deps.channel(message.channel);
  // الاختبار يُسمح على قناةٍ غير مفعّلة بعد (هو ما يسبق التفعيل)؛ والإرسال الفعلي لا.
  if ((!view.enabled && message.purpose !== "test") || !secret) {
    return { ok: false, message: NOT_READY[message.channel], deliveryId: null, status: 409 };
  }

  let counterpart: string | null;
  let outcome: { ok: true; providerId: string | null } | { ok: false; error: string };
  if (message.channel === "whatsapp") {
    counterpart = toWhatsAppNumber(message.to);
    if (!counterpart) return { ok: false, message: "رقم الجوال غير صالح لواتساب.", deliveryId: null, status: 400 };
    const config = view.config as WhatsAppChannelConfig;
    const result = await sendWhatsAppText(
      { token: secret, phoneNumberId: config.phoneNumberId, graphVersion: config.graphVersion },
      counterpart, body, deps.fetchImpl ?? fetch,
    );
    outcome = result.ok ? { ok: true, providerId: result.messageId } : { ok: false, error: result.message };
  } else if (message.channel === "sms") {
    const config = view.config as SmsChannelConfig;
    counterpart = smsRecipient(message.to, config.numberFormat);
    if (!counterpart) return { ok: false, message: "رقم الجوال غير صالح للرسائل النصية.", deliveryId: null, status: 400 };
    outcome = await sendSms(config, secret, counterpart, body, deps.fetchImpl ?? fetch);
  } else {
    const config = view.config as EmailChannelConfig;
    counterpart = message.to.trim();
    if (!isEmail(counterpart)) return { ok: false, message: "عنوان البريد غير صالح.", deliveryId: null, status: 400 };
    const subject = (message.subject ?? "").trim() || "رسالة من المركز";
    const result = await sendMail(
      { host: config.host, port: config.port, security: config.security, username: config.username, password: secret },
      { fromAddress: config.fromAddress, fromName: config.fromName, to: counterpart, subject, text: body },
      deps.smtpTransport,
    );
    outcome = result.ok ? { ok: true, providerId: null } : { ok: false, error: result.message };
  }

  const deliveryId = await deps.record({
    channel: message.channel,
    patientId: message.patientId,
    counterpart,
    subject: message.channel === "email" ? (message.subject ?? null) : null,
    body,
    purpose: message.purpose,
    status: outcome.ok ? "sent" : "failed",
    providerMessageId: outcome.ok ? outcome.providerId : null,
    error: outcome.ok ? null : outcome.error,
    createdBy: message.actor,
  });
  return outcome.ok
    ? { ok: true, deliveryId }
    : { ok: false, message: outcome.error, deliveryId, status: 502 };
}

async function sendSms(
  config: SmsChannelConfig,
  apiKey: string,
  to: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; providerId: string | null } | { ok: false; error: string }> {
  const request = buildSmsRequest(config, apiKey, to, body);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "تعذّر الاتصال ببوابة الرسائل النصية." };
  }
  const text = await response.text().catch(() => "");
  if (smsResponseOk(response.status, text, config.successPattern)) return { ok: true, providerId: null };
  if (response.status === 401 || response.status === 403) return { ok: false, error: "رفضت بوابة الرسائل بيانات الدخول — راجع المستخدم والمفتاح." };
  return { ok: false, error: "رفضت بوابة الرسائل الإرسال — راجع إعدادات البوابة ورصيدك لديها." };
}
