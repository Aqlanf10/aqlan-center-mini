/**
 * (MSG-1) قنوات المراسلة الخارجية وإعداداتها — منطقٌ خالص يُختبر بلا قاعدة ولا شبكة.
 *
 * طلب المالك: «وحدة الرسائل تشمل الداخلية وواتساب والرسائل النصية، ولكل وحدةٍ إعداداتها
 * لأتحكم برقم الواتس ورقم الرسائل، وأيضًا البريد». فلكل قناةٍ:
 *
 * - **واتساب للأعمال** (Cloud API): معرّف رقم الهاتف والرقم الظاهر للمرضى، والرمز سرًّا،
 *   واسم قالب التذكير ولغته.
 * - **الرسائل النصية** عبر بوابة يمنية: موصلٌ HTTP قابل للتهيئة — عنوان البوابة وطريقتها
 *   وأسماء حقولها (الرقم، النص، المرسل، المستخدم، المفتاح)، واسم المرسل، وصيغة الرقم،
 *   ونصٌّ يدل على النجاح في ردّها؛ والمفتاح سرًّا. فيعمل مع أغلب البوابات المحلية بلا كود.
 * - **البريد** (SMTP): الخادم والمنفذ والتشفير والمستخدم وعنوان المرسل واسمه؛ وكلمة المرور سرًّا.
 *
 * السرّ لا يعود إلى الشاشة أبدًا: الشاشة ترى «مضبوط/غير مضبوط» فقط.
 */
import { toWhatsAppNumber } from "./reminders";

export const CHANNELS = ["whatsapp", "sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: "واتساب للأعمال",
  sms: "الرسائل النصية (SMS)",
  email: "البريد الإلكتروني",
};

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  displayNumber: string;
  graphVersion: string;
}

export interface SmsChannelConfig {
  url: string;
  method: "GET" | "POST";
  /** POST: جسم نموذج (form) أو JSON. */
  bodyFormat: "form" | "json";
  toParam: string;
  textParam: string;
  senderParam: string;
  userParam: string;
  keyParam: string;
  sender: string;
  username: string;
  /** صيغة الرقم الذي تطلبه البوابة: دولي 967… أو محلي 7… */
  numberFormat: "international" | "local";
  /** نصٌّ في ردّ البوابة يدل على النجاح (فارغ = يكفي رمز HTTP 2xx). */
  successPattern: string;
}

export interface EmailChannelConfig {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  fromAddress: string;
  fromName: string;
}

export interface ChannelConfigMap {
  whatsapp: WhatsAppChannelConfig;
  sms: SmsChannelConfig;
  email: EmailChannelConfig;
}

export const DEFAULT_CONFIG: ChannelConfigMap = {
  // قالب التذكير الآلي ولغته في إعدادات «التذكير الآلي» (reminders.auto_template / auto_language).
  whatsapp: { phoneNumberId: "", displayNumber: "", graphVersion: "v21.0" },
  sms: {
    url: "", method: "POST", bodyFormat: "form", toParam: "to", textParam: "message", senderParam: "sender",
    userParam: "username", keyParam: "api_key", sender: "", username: "", numberFormat: "international", successPattern: "",
  },
  email: { host: "", port: 587, security: "starttls", username: "", fromAddress: "", fromName: "" },
};

/** ما يُسمَّى به السرّ في الشاشة لكل قناة. */
export const SECRET_LABEL: Record<Channel, string> = {
  whatsapp: "رمز الوصول الدائم (System User token)",
  sms: "مفتاح/كلمة مرور البوابة",
  email: "كلمة مرور البريد (أو كلمة مرور التطبيق)",
};

const text = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const PARAM = /^[A-Za-z0-9_.\-[\]]{1,60}$/;

/**
 * يطبّع إعدادات القناة القادمة من الشاشة ويتحقق منها. يُعيد رسالة عربية بأول خطأ، أو
 * الإعدادات المطبَّعة. القناة المعطَّلة تُحفظ ولو ناقصة (مسودة)؛ والمفعَّلة يجب أن تكتمل.
 */
export function normalizeChannelConfig<C extends Channel>(
  channel: C,
  raw: unknown,
  enabled: boolean,
): { ok: true; config: ChannelConfigMap[C] } | { ok: false; message: string } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (channel === "whatsapp") {
    const config: WhatsAppChannelConfig = {
      phoneNumberId: text(input.phoneNumberId, 40),
      displayNumber: text(input.displayNumber, 30),
      graphVersion: text(input.graphVersion, 10) || DEFAULT_CONFIG.whatsapp.graphVersion,
    };
    if (config.phoneNumberId && !/^\d{5,30}$/.test(config.phoneNumberId)) return { ok: false, message: "معرّف رقم الهاتف لدى Meta أرقامٌ فقط." };
    if (!/^v\d+\.\d+$/.test(config.graphVersion)) return { ok: false, message: "إصدار الواجهة بصيغة v21.0." };
    if (enabled && !config.phoneNumberId) return { ok: false, message: "أدخل معرّف رقم الهاتف لدى Meta قبل التفعيل." };
    return { ok: true, config: config as ChannelConfigMap[C] };
  }
  if (channel === "sms") {
    const config: SmsChannelConfig = {
      url: text(input.url, 500),
      method: input.method === "GET" ? "GET" : "POST",
      bodyFormat: input.bodyFormat === "json" ? "json" : "form",
      toParam: text(input.toParam, 60) || DEFAULT_CONFIG.sms.toParam,
      textParam: text(input.textParam, 60) || DEFAULT_CONFIG.sms.textParam,
      senderParam: text(input.senderParam, 60),
      userParam: text(input.userParam, 60),
      keyParam: text(input.keyParam, 60),
      sender: text(input.sender, 30),
      username: text(input.username, 120),
      numberFormat: input.numberFormat === "local" ? "local" : "international",
      successPattern: text(input.successPattern, 120),
    };
    for (const [name, value] of [["الرقم", config.toParam], ["النص", config.textParam], ["المرسل", config.senderParam], ["المستخدم", config.userParam], ["المفتاح", config.keyParam]] as const) {
      if (value && !PARAM.test(value)) return { ok: false, message: `اسم حقل ${name} غير صالح: حروف لاتينية وأرقام و_ . - فقط.` };
    }
    if (config.url) {
      let parsed: URL;
      try { parsed = new URL(config.url); } catch { return { ok: false, message: "عنوان البوابة غير صالح." }; }
      if (parsed.protocol !== "https:") return { ok: false, message: "عنوان البوابة يجب أن يبدأ بـ https:// — لا يُرسل المفتاح بلا تشفير." };
    }
    if (enabled && !config.url) return { ok: false, message: "أدخل عنوان بوابة الرسائل قبل التفعيل." };
    return { ok: true, config: config as ChannelConfigMap[C] };
  }
  const port = Number(input.port);
  const config: EmailChannelConfig = {
    host: text(input.host, 200),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.email.port,
    security: input.security === "tls" ? "tls" : "starttls",
    username: text(input.username, 200),
    fromAddress: text(input.fromAddress, 200),
    fromName: text(input.fromName, 120),
  };
  if (config.host && !/^[A-Za-z0-9.-]{1,200}$/.test(config.host)) return { ok: false, message: "اسم خادم البريد غير صالح." };
  if (config.fromAddress && !isEmail(config.fromAddress)) return { ok: false, message: "عنوان المرسل ليس بريدًا صالحًا." };
  if (enabled && (!config.host || !config.fromAddress)) return { ok: false, message: "أدخل خادم البريد وعنوان المرسل قبل التفعيل." };
  return { ok: true, config: config as ChannelConfigMap[C] };
}

export function isEmail(value: string): boolean {
  return /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/.test(value);
}

/** إعدادات القناة المخزَّنة مدموجةً بالافتراضي — لقراءة صفٍّ قديم أو ناقص. */
export function withDefaults<C extends Channel>(channel: C, stored: unknown): ChannelConfigMap[C] {
  const base = DEFAULT_CONFIG[channel];
  const input = (stored && typeof stored === "object" ? stored : {}) as Partial<ChannelConfigMap[C]>;
  return { ...base, ...input } as ChannelConfigMap[C];
}

/** رقم المستلم بالصيغة التي تطلبها البوابة — أو null إن لم يكن جوالًا يمنيًّا صالحًا. */
export function smsRecipient(phone: string | null | undefined, format: SmsChannelConfig["numberFormat"]): string | null {
  const international = toWhatsAppNumber(phone);
  if (!international) return null;
  return format === "local" ? international.replace(/^967/, "") : international;
}

/** طلب بوابة الرسائل النصية — دالة خالصة: العنوان والطريقة والترويسات والجسم. */
export function buildSmsRequest(config: SmsChannelConfig, apiKey: string, to: string, message: string): {
  url: string; method: "GET" | "POST"; headers: Record<string, string>; body: string | null;
} {
  const fields: [string, string][] = [[config.toParam, to], [config.textParam, message]];
  if (config.senderParam && config.sender) fields.push([config.senderParam, config.sender]);
  if (config.userParam && config.username) fields.push([config.userParam, config.username]);
  if (config.keyParam && apiKey) fields.push([config.keyParam, apiKey]);
  if (config.method === "GET") {
    const url = new URL(config.url);
    for (const [name, value] of fields) url.searchParams.set(name, value);
    return { url: url.toString(), method: "GET", headers: {}, body: null };
  }
  if (config.bodyFormat === "json") {
    return {
      url: config.url, method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(fields)),
    };
  }
  return {
    url: config.url, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** هل نجح الإرسال بحسب ردّ البوابة؟ 2xx، وإن ضُبط نصّ النجاح فيجب أن يظهر في الرد. */
export function smsResponseOk(status: number, body: string, successPattern: string): boolean {
  if (status < 200 || status >= 300) return false;
  return successPattern ? body.includes(successPattern) : true;
}
