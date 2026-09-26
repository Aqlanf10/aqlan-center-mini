/**
 * (P2-12) التذكير الآلي عبر واتساب للأعمال — واجهة WhatsApp Cloud API من Meta.
 *
 * رابط `wa.me` (lib/reminders) يبقى كما هو: الموظفة تضغط فيفتح واتساب. وهذا المسار
 * يُرسل وحده، بلا موظفة، رسالةً من **قالبٍ معتمد لدى Meta** — فالرسالة التي يبدأها
 * النشاط التجاري لا تُقبل إلا بقالبٍ مُسبق الموافقة (template) بمتغيّراتٍ مرقّمة.
 *
 * الأسرار من البيئة وحدها (لا قاعدة ولا سجل): `WHATSAPP_CLOUD_TOKEN` و
 * `WHATSAPP_PHONE_NUMBER_ID`، واختياريًّا `WHATSAPP_GRAPH_VERSION`. ورسائل الخطأ
 * عربية معقّمة: لا رمزٌ ولا جسمُ استجابةٍ خام يخرج منها.
 */

export interface WhatsAppCloudConfig {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  /** (MSG-3) مزوّدٌ شريك بواجهةٍ مطابقة لـCloud API (طريق «التعايش» مع تطبيق الجوال). */
  provider?: "meta" | "bsp";
  apiBaseUrl?: string;
  authHeader?: string;
}

/** عنوان الإرسال وترويساته — Meta مباشرةً أو المزوّد الشريك. دالة خالصة. */
export function whatsAppEndpoint(config: WhatsAppCloudConfig): { url: string; headers: Record<string, string> } {
  if (config.provider === "bsp" && config.apiBaseUrl) {
    return {
      url: `${config.apiBaseUrl.replace(/\/+$/, "")}/messages`,
      headers: { [config.authHeader || "D360-API-KEY"]: config.token, "content-type": "application/json" },
    };
  }
  return {
    url: `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`,
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
  };
}

export const WHATSAPP_DEFAULT_GRAPH_VERSION = "v21.0";

/** التكوين من البيئة، أو null إن نقص — فالإرسال الآلي معطَّلٌ حتى يُهيَّأ. */
export function whatsAppCloudConfig(env: Readonly<Record<string, string | undefined>> = process.env): WhatsAppCloudConfig | null {
  const token = env.WHATSAPP_CLOUD_TOKEN?.trim() ?? "";
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const graphVersion = env.WHATSAPP_GRAPH_VERSION?.trim() || WHATSAPP_DEFAULT_GRAPH_VERSION;
  if (!token || !/^\d{5,30}$/.test(phoneNumberId) || !/^v\d+\.\d+$/.test(graphVersion)) return null;
  return { token, phoneNumberId, graphVersion };
}

export interface TemplateMessage {
  /** الرقم الدولي بلا «+» (967xxxxxxxxx). */
  to: string;
  templateName: string;
  languageCode: string;
  /** متغيّرات جسم القالب بالترتيب: {{1}}، {{2}}، … */
  bodyParams: readonly string[];
}

export type SendResult =
  | { ok: true; messageId: string | null }
  /** recipientOnly: الرفض يخص هذا الرقم وحده (لا القالب ولا الرمز). */
  | { ok: false; message: string; retriable: boolean; recipientOnly: boolean };

/** جسم الطلب كما تطلبه Meta — دالة خالصة تُختبر بلا شبكة. */
export function templatePayload(message: TemplateMessage) {
  return {
    messaging_product: "whatsapp",
    to: message.to,
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.languageCode },
      components: message.bodyParams.length > 0
        ? [{ type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text: text.slice(0, 1024) })) }]
        : [],
    },
  };
}

/** رمز خطأ Meta → رسالة عربية للمدير، وهل تُعاد المحاولة لاحقًا. */
function describeFailure(status: number, code: number | null): { message: string; retriable: boolean; recipientOnly: boolean } {
  if (status === 401 || code === 190) return { message: "رمز واتساب للأعمال غير صالح أو منتهٍ — حدّثه في بيئة الخادم.", retriable: false, recipientOnly: false };
  if (code === 132001) return { message: "قالب التذكير غير موجود أو غير معتمد بهذه اللغة لدى Meta.", retriable: false, recipientOnly: false };
  if (code === 132000) return { message: "عدد متغيّرات القالب لا يطابق المعتمد لدى Meta.", retriable: false, recipientOnly: false };
  if (code === 131026 || code === 131047) return { message: "تعذّر التسليم لهذا الرقم (ليس على واتساب أو خارج نافذة المحادثة).", retriable: false, recipientOnly: true };
  if (status === 429 || code === 130429 || code === 131056) return { message: "تجاوز حدّ الإرسال لدى Meta — يُعاد لاحقًا.", retriable: true, recipientOnly: false };
  if (status >= 500) return { message: "خدمة واتساب لا تستجيب الآن — يُعاد لاحقًا.", retriable: true, recipientOnly: false };
  return { message: "رفضت Meta الرسالة.", retriable: false, recipientOnly: false };
}

/** (MSG-1) رسالة نصية حرّة — تُقبل داخل نافذة المحادثة (٢٤ ساعة بعد آخر رسالةٍ من المريض). */
export function textPayload(to: string, body: string) {
  return { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: body.slice(0, 4096) } };
}

export async function sendWhatsAppText(
  config: WhatsAppCloudConfig,
  to: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<SendResult> {
  return postToGraph(config, textPayload(to, body), fetchImpl, timeoutMs);
}

export async function sendWhatsAppTemplate(
  config: WhatsAppCloudConfig,
  message: TemplateMessage,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<SendResult> {
  return postToGraph(config, templatePayload(message), fetchImpl, timeoutMs);
}

async function postToGraph(
  config: WhatsAppCloudConfig,
  requestBody: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SendResult> {
  const { url, headers } = whatsAppEndpoint(config);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, message: "تعذّر الاتصال بخدمة واتساب — يُعاد لاحقًا.", retriable: true, recipientOnly: false };
  }
  const payload = (await response.json().catch(() => null)) as
    | { messages?: { id?: unknown }[]; error?: { code?: unknown } }
    | null;
  if (response.ok) {
    const id = payload?.messages?.[0]?.id;
    return { ok: true, messageId: typeof id === "string" ? id : null };
  }
  const code = typeof payload?.error?.code === "number" ? payload.error.code : null;
  return { ok: false, ...describeFailure(response.status, code) };
}
