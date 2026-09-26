/**
 * (PAT-3) هوية المريض وتواصله — الأعلام، البريد، وموافقات التواصل لكل قناة.
 *
 * - **الأعلام**: وسومٌ ملوّنة تظهر في كل شاشة (VIP، متأخر السداد، يحتاج مرافقًا…) —
 *   قائمتها من الإعداد `patients.flags` لا من الشيفرة. العلَم يُحفظ بنصّه: إن غيّر المدير
 *   القائمة لاحقًا يبقى علَم المريض القديم ظاهرًا (رماديًّا) حتى يُزال — لا يختفي بصمت.
 * - **الموافقة**: سجلٌّ مؤرَّخ لا يُعدَّل (منح/سحب، من أين، ومن سجّل). الحالة = آخر قيدٍ
 *   لكل قناة. ووضع المركز (`messaging.consent_mode`) يقرر معنى «لا قيد»:
 *   `opt_out` (الافتراضي) يُرسَل ما لم يسحب المريض موافقته، و`opt_in` لا يُرسَل إلا بموافقةٍ مسجّلة.
 * - **«توقف»**: رسالةٌ واردة بكلمة إيقاف تسحب موافقة تلك القناة تلقائيًّا — كما تفعل الأنظمة الرائدة.
 *
 * منطقٌ خالص يُختبر بلا قاعدة.
 */

export const CONSENT_CHANNELS = ["whatsapp", "sms", "email"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_CHANNEL_LABEL: Record<ConsentChannel, string> = {
  whatsapp: "واتساب",
  sms: "الرسائل النصية",
  email: "البريد",
};

export const CONSENT_SOURCES = ["in_person", "phone", "written", "portal", "inbound_stop"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_SOURCE_LABEL: Record<ConsentSource, string> = {
  in_person: "شفهيًّا في المركز",
  phone: "هاتفيًّا",
  written: "إقرار مكتوب",
  portal: "بوابة المريض",
  inbound_stop: "طلب إيقاف برسالة",
};

/** ما يُختار يدويًّا — «طلب إيقاف برسالة» يسجّله النظام وحده. */
export const MANUAL_CONSENT_SOURCES: ConsentSource[] = ["in_person", "phone", "written", "portal"];

export type ConsentState = "granted" | "withdrawn" | "unknown";
export type ConsentMode = "opt_out" | "opt_in";

export const PREFERRED_CHANNELS = ["whatsapp", "sms", "email", "call"] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

export const PREFERRED_CHANNEL_LABEL: Record<PreferredChannel, string> = {
  whatsapp: "واتساب",
  sms: "رسالة نصية",
  email: "بريد",
  call: "اتصال هاتفي",
};

export function isConsentChannel(value: unknown): value is ConsentChannel {
  return typeof value === "string" && (CONSENT_CHANNELS as readonly string[]).includes(value);
}

export function isConsentSource(value: unknown): value is ConsentSource {
  return typeof value === "string" && (CONSENT_SOURCES as readonly string[]).includes(value);
}

export function isPreferredChannel(value: unknown): value is PreferredChannel {
  return typeof value === "string" && (PREFERRED_CHANNELS as readonly string[]).includes(value);
}

export function parseConsentMode(value: string | null | undefined): ConsentMode {
  return value === "opt_in" ? "opt_in" : "opt_out";
}

/** هل يُسمح بالمراسلة على هذه القناة؟ */
export function consentAllows(state: ConsentState, mode: ConsentMode): boolean {
  return mode === "opt_in" ? state === "granted" : state !== "withdrawn";
}

export function consentBlockedMessage(channel: ConsentChannel, state: ConsentState): string {
  const name = CONSENT_CHANNEL_LABEL[channel];
  return state === "withdrawn"
    ? `المريض سحب موافقته على المراسلة عبر ${name} — لا تُرسل له. عدّلها من ملفه إن وافق من جديد.`
    : `لا موافقة مسجّلة من المريض على المراسلة عبر ${name} — سجّلها في ملفه أولًا.`;
}

/** آخر قيدٍ لكل قناة → الحالة. القيود بأي ترتيب؛ الأحدث (بالمعرّف) يغلب. */
export function consentStates(
  events: ReadonlyArray<{ id: number; channel: ConsentChannel; granted: boolean }>,
): Record<ConsentChannel, ConsentState> {
  const latest = new Map<ConsentChannel, { id: number; granted: boolean }>();
  for (const event of events) {
    const current = latest.get(event.channel);
    if (!current || event.id > current.id) latest.set(event.channel, event);
  }
  const result = { whatsapp: "unknown", sms: "unknown", email: "unknown" } as Record<ConsentChannel, ConsentState>;
  for (const [channel, event] of latest) result[channel] = event.granted ? "granted" : "withdrawn";
  return result;
}

/* ─────────────────────────── كلمات الإيقاف ─────────────────────────── */

function looseArabic(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const STOP_PHRASES = new Set([
  "stop", "unsubscribe", "stop all", "cancel",
  "توقف", "توقيف", "ايقاف", "اوقف", "الغاء", "الغاء الاشتراك", "لا ترسل", "لا ترسلوا", "لا اريد رسائل",
].map(looseArabic));

/** رسالةٌ واردة **كلُّها** كلمة إيقاف — «توقف» أو «STOP» — لا جملةٌ تحويها عَرَضًا. */
export function isStopRequest(body: string): boolean {
  const text = looseArabic(body);
  return text.length > 0 && text.length <= 30 && STOP_PHRASES.has(text);
}

/* ─────────────────────────── الأعلام ─────────────────────────── */

export const FLAG_MAX_LENGTH = 30;
export const MAX_FLAGS_PER_PATIENT = 8;

/** قائمة الأعلام من الإعداد: فاصلة لاتينية أو عربية، بلا فراغٍ ولا تكرار. */
export function parseFlagList(setting: string | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of (setting ?? "").split(/[,،]/)) {
    const label = part.trim().slice(0, FLAG_MAX_LENGTH);
    if (label && !seen.has(label)) { seen.add(label); result.push(label); }
  }
  return result.slice(0, 30);
}

/**
 * أعلام المريض المرسلة من الشاشة. `allowed` = قائمة الإعداد الحالية؛ والعلَم القديم الذي
 * كان على المريض (`existing`) يُقبل بقاؤه وإن خرج من القائمة — لا يُجبر حفظُ ملفٍ على محوه.
 */
export function normalizePatientFlags(
  input: unknown,
  allowed: readonly string[],
  existing: readonly string[] = [],
): { ok: true; flags: string[] } | { ok: false; message: string } {
  if (input === null || input === undefined) return { ok: true, flags: [] };
  if (!Array.isArray(input)) return { ok: false, message: "الأعلام قائمة." };
  const permitted = new Set([...allowed, ...existing]);
  const flags: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return { ok: false, message: "الأعلام قائمة." };
    const label = item.trim();
    if (!label || flags.includes(label)) continue;
    if (!permitted.has(label)) return { ok: false, message: `العلَم «${label.slice(0, FLAG_MAX_LENGTH)}» ليس في قائمة الأعلام — أضفه من الإعدادات أولًا.` };
    flags.push(label);
  }
  // ملفٌّ دُمج فيه مكرر قد يحمل أكثر من الحد — يُحفظ كما هو، ولا يُزاد عليه.
  if (flags.length > MAX_FLAGS_PER_PATIENT && flags.some((flag) => !existing.includes(flag))) return { ok: false, message: `أقصى عدد للأعلام ${MAX_FLAGS_PER_PATIENT}.` };
  return { ok: true, flags };
}

const FLAG_PALETTE = [
  "border-violet-200 bg-violet-50 text-violet-800",
  "border-amber-200 bg-amber-50 text-amber-800",
  "border-sky-200 bg-sky-50 text-sky-800",
  "border-rose-200 bg-rose-50 text-rose-800",
  "border-emerald-200 bg-emerald-50 text-emerald-800",
  "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800",
  "border-orange-200 bg-orange-50 text-orange-800",
  "border-teal-200 bg-teal-50 text-teal-800",
] as const;

export const RETIRED_FLAG_CLASS = "border-slate-200 bg-slate-50 text-slate-500";

/** لونٌ ثابت لكل علَم بحسب موضعه في القائمة — العلَم الخارج من القائمة رمادي. */
export function flagClass(label: string, list: readonly string[]): string {
  const index = list.indexOf(label);
  return index < 0 ? RETIRED_FLAG_CLASS : FLAG_PALETTE[index % FLAG_PALETTE.length];
}

/* ─────────────────────────── البريد ─────────────────────────── */

/** بريد المريض: فارغ = لا بريد؛ وإلا صيغةٌ صالحة بطولٍ معقول، بحروفٍ صغيرة. */
export function normalizePatientEmail(value: unknown): { ok: true; email: string | null } | { ok: false; message: string } {
  if (value === null || value === undefined) return { ok: true, email: null };
  if (typeof value !== "string") return { ok: false, message: "البريد نص." };
  const email = value.trim().toLowerCase();
  if (!email) return { ok: true, email: null };
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, message: "صيغة البريد غير صحيحة." };
  return { ok: true, email };
}
