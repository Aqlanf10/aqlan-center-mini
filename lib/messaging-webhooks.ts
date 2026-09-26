/**
 * (MSG-2) معالجة webhooks القنوات الخارجية — بتبعياتٍ محقونة فتُختبر بلا شبكة ولا قاعدة.
 *
 * - واتساب: تحقق الاشتراك (GET) برمز التحقق، ثم كل POST يُتحقق توقيعه (App Secret) على الجسم
 *   الخام قبل قراءة أي شيء؛ غير الموقّع أو المزوّر أو قناةٌ بلا App Secret ⇒ 403 بلا معالجة.
 * - الرسائل النصية: مفتاح الاستقبال في العنوان يُقارن بزمنٍ ثابت؛ غيابه أو خطؤه ⇒ 403.
 * - القناة المعطّلة: يُردّ 200 ويُتجاهل الوارد (لا إعادة محاولاتٍ بلا نهاية من المزوّد).
 * - الوارد يُسجَّل مرة واحدة (معرّف المزوّد فريد) ويُربط بالمريض إن عُرف رقمه بلا تخمين.
 */
import type { Channel } from "./messaging-channels";
import {
  constantTimeEqual, parseSmsInbound, parseWhatsAppWebhook, validMetaSignature, type InboundMessage,
} from "./messaging-inbound";

export interface WebhookChannel {
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface WebhookDeps {
  channel(channel: Channel): Promise<WebhookChannel>;
  patientFor(channel: Channel, from: string): Promise<number | null>;
  recordInbound(entry: { channel: Channel; patientId: number | null; message: InboundMessage }): Promise<void>;
  markFailed(channel: Channel, providerMessageId: string, error: string): Promise<void>;
}

export interface WebhookOutcome {
  status: 200 | 400 | 403;
  /** نص خام (تحدي Meta) أو JSON. */
  text?: string;
  json?: Record<string, unknown>;
  received?: number;
}

const FORBIDDEN: WebhookOutcome = { status: 403, json: { message: "طلب غير مصرّح به." } };

function configText(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/** تحقق اشتراك Meta: يُعاد التحدي نصًّا إن طابق الرمز. */
export async function whatsAppVerify(params: URLSearchParams, deps: Pick<WebhookDeps, "channel">): Promise<WebhookOutcome> {
  const channel = await deps.channel("whatsapp");
  const expected = configText(channel.config, "verifyToken");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  if (params.get("hub.mode") !== "subscribe" || !expected || !token || !constantTimeEqual(token, expected)) return FORBIDDEN;
  if (!/^[\w-]{1,200}$/.test(challenge)) return { status: 400, json: { message: "طلب تحقق غير صالح." } };
  return { status: 200, text: challenge };
}

async function storeInbound(channel: Channel, messages: InboundMessage[], deps: WebhookDeps): Promise<number> {
  let stored = 0;
  for (const message of messages) {
    const patientId = await deps.patientFor(channel, message.from);
    await deps.recordInbound({ channel, patientId, message });
    stored += 1;
  }
  return stored;
}

export async function whatsAppReceive(rawBody: string, signature: string | null, deps: WebhookDeps): Promise<WebhookOutcome> {
  const channel = await deps.channel("whatsapp");
  const appSecret = channel.secrets.appSecret ?? "";
  if (!validMetaSignature(rawBody, signature, appSecret)) return FORBIDDEN;
  if (!channel.enabled) return { status: 200, json: { ok: true, ignored: true }, received: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { message: "طلب غير صالح." } };
  }
  const { messages, statuses } = parseWhatsAppWebhook(payload);
  for (const update of statuses) {
    if (update.status === "failed" && update.error) await deps.markFailed("whatsapp", update.providerMessageId, update.error);
  }
  const received = await storeInbound("whatsapp", messages, deps);
  return { status: 200, json: { ok: true }, received };
}

export async function smsReceive(key: string, fields: Record<string, unknown>, deps: WebhookDeps): Promise<WebhookOutcome> {
  const channel = await deps.channel("sms");
  const expected = configText(channel.config, "inboundKey");
  if (!expected || !key || !constantTimeEqual(key, expected)) return FORBIDDEN;
  if (!channel.enabled) return { status: 200, json: { ok: true, ignored: true }, received: 0 };
  const message = parseSmsInbound(fields);
  if (!message) return { status: 400, json: { message: "الرسالة الواردة ينقصها الرقم أو النص." } };
  const received = await storeInbound("sms", [message], deps);
  return { status: 200, json: { ok: true }, received };
}
