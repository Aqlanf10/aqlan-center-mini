/**
 * خدمة الذكاء الاصطناعي — صاحب المجال الوحيد.
 *
 * **القاعدة الدستورية الحاكمة (المادة 214): الذكاء الاصطناعي يقترح ولا يعتمد.**
 * لا يعتمد أي تشخيص طبي أو حركة مالية دون تأكيد صريح من المستخدم — كل ما تنتجه
 * هذه الخدمة «اقتراح» يُعرض على الطبيب، والاعتماد بيد الطبيب حصرًا. لا مسار
 * برمجي يعتمد مخرجها تلقائيًا، اليوم ولا غدًا.
 *
 * **قاعدة الخصوصية (المادة 202): لا تُرسل معلومات الهوية الصريحة** — أسماء المرضى
 * وأرقام هواتفهم وملفاتهم وأرقامهم الوطنية لا تخرج من المركز إطلاقًا. ما يُرسل
 * بيانات سريرية مجرّدة: قياسات، زوايا، أصناف، أوصاف حالة بلا ربط بشخص. حارس
 * `sanitizeForPrivacy` يزيل الأنماط الصريحة قبل أي خروج، ومَن يستدعي هذه الوحدة
 * يُسأل عن محتوى ما يرسله.
 *
 * مفتاح الخدمة يوفره المالك من شاشة الإعدادات ويُخزَّن مشفَّرًا (انظر
 * `lib/secretbox.ts`)، ولا يعود من أي مسار قراءة إلا بصمة مُقنَّعة.
 *
 * البروتوكول: OpenAI-compatible chat completions — اختير لأنه لغة مشتركة بين
 * مزوّدين كثر (Z.ai / GLM وOpenAI وأي واجهة متوافقة)، فتغيير المزوّد ضبطُ
 * عنوانٍ ونموذجٍ من الشاشة لا بنشرة برمجية.
 */

import { getPool, recordAudit } from "./db";
import { decryptSecret, encryptSecret, maskKey } from "./secretbox";

// ─── المزوّدون ───────────────────────────────────────────────────────────────

/** قائمة مغلقة: مزوّد يُضاف فقط بقرار معماري، لا بحقل نصّي حرّ في القاعدة. */
export const AI_PROVIDERS = ["zai", "openai", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  zai: "Z.ai / GLM",
  openai: "OpenAI",
  custom: "واجهة متوافقة (OpenAI-compatible)",
};

/** العناوين الافتراضية: أيها يُملأ قبل أن يلمس المالك الحقل، والمخصص يتركه له. */
export const AI_DEFAULT_BASE_URL: Record<AiProvider, string> = {
  zai: "https://api.z.ai/api/paas/v4",
  openai: "https://api.openai.com/v1",
  custom: "",
};

/** النماذج المقترحة تظهر كتلميح في الشاشة — الحقل نفسه حرّ لتتبع تحديثات المزوّد. */
export const AI_MODEL_HINT: Record<AiProvider, string> = {
  zai: "glm-4.6",
  openai: "gpt-4o-mini",
  custom: "",
};

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

// ─── الحالة المحفوظة ─────────────────────────────────────────────────────────

export interface AiSettingsRow {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKeyEnc: string | null;
  keyMasked: string;
  hasKey: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

const DEFAULTS = {
  enabled: false,
  provider: "zai" as AiProvider,
};

/** يقرأ الصف الوحيد — بلا صفٍّ يعيد الافتراضي: الخدمة معطّلة حتى يضبطها المالك. */
export async function getAiSettings(): Promise<AiSettingsRow> {
  const { rows } = await getPool().query<{
    enabled: boolean;
    provider: string;
    base_url: string;
    model: string;
    api_key_enc: string | null;
    last_test_at: Date | null;
    last_test_ok: boolean | null;
    last_test_message: string | null;
    updated_by: string | null;
    updated_at: Date | null;
  }>(`SELECT enabled, provider, base_url, model, api_key_enc,
             last_test_at, last_test_ok, last_test_message, updated_by, updated_at
      FROM ai_settings WHERE id = 1`);

  if (rows.length === 0) {
    return {
      ...DEFAULTS,
      baseUrl: AI_DEFAULT_BASE_URL[DEFAULTS.provider],
      model: AI_MODEL_HINT[DEFAULTS.provider],
      apiKeyEnc: null,
      keyMasked: "",
      hasKey: false,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      updatedBy: null,
      updatedAt: null,
    };
  }

  const row = rows[0];
  const provider: AiProvider = isAiProvider(row.provider) ? row.provider : DEFAULTS.provider;
  let keyMasked = "";
  if (row.api_key_enc) {
    try {
      keyMasked = maskKey(decryptSecret(row.api_key_enc));
    } catch {
      // مفتاح لا يُفك — SESSION_SECRET دُوِّر أو النص مُفسَّد: نعرض أنه موجود
      // ولا نعرض بصمة زائفة، وإعادة إدخال المفتاح تحل الأمر.
      keyMasked = "•••••••• (غير قابل للفك — أعد إدخال المفتاح)";
    }
  }
  return {
    enabled: row.enabled,
    provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyEnc: row.api_key_enc,
    keyMasked,
    hasKey: Boolean(row.api_key_enc),
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok,
    lastTestMessage: row.last_test_message,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/**
 * ما يخرج إلى الواجهة: كل شيء ما عدا النص المشفّر نفسه — بصلته لا لقيمته.
 * حتى البصمة مُقنَّعة، والمفتاح الأصلي لا يعود من أي مسار قراءة إطلاقًا.
 */
export function toAiSettingsView(settings: AiSettingsRow) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasKey: settings.hasKey,
    keyMasked: settings.keyMasked,
    lastTestAt: settings.lastTestAt ? settings.lastTestAt.toISOString() : null,
    lastTestOk: settings.lastTestOk,
    lastTestMessage: settings.lastTestMessage,
    updatedBy: settings.updatedBy,
    updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
    // مرجع الشاشة: قائمة المزوّدون وعناوينهم ونماذجهم المقترحة — حتى يضيف المالك
    // مزوّدًا أو يغيّره دون أن يسأل أحدًا عن العنوان الصحيح.
    providers: AI_PROVIDERS.map((provider) => ({
      value: provider,
      label: AI_PROVIDER_LABEL[provider],
      defaultBaseUrl: AI_DEFAULT_BASE_URL[provider],
      modelHint: AI_MODEL_HINT[provider],
    })),
  };
}

// ─── التحقق ──────────────────────────────────────────────────────────────────

export interface AiSettingsInput {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** نصّ المفتاح الجديد. undefined = إبقاء الموجود؛ نصّ فارغ = الإبقاء أيضًا. */
  apiKey?: string | undefined;
}

/** يتحقق ويعيد رسالة أول خطأ — أو null إن صحّ كل شيء. */
export function validateAiInput(input: AiSettingsInput): string | null {
  if (!isAiProvider(input.provider)) return "المزوّد غير معروف.";
  const base = input.baseUrl.trim();
  if (!/^https?:\/\/.+/.test(base)) return "عنوان الخدمة يجب أن يبدأ بـ http:// أو https://.";
  if (base.length > 300) return "عنوان الخدمة طويل بغير منطق.";
  const model = input.model.trim();
  if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) {
    return "اسم النموذج: حروف لاتينية وأرقام ونقاط وشرطات فقط، حتى 120 حرفًا.";
  }
  // «التمكين يتطلب مفتاحًا» تُفحص في المسار: المفحّص الخالص لا يعرف هل يوجد
  // مفتاح محفوظ سابقًا — وتمكين الخدمة بمفتاح محفوظ صحيح دون إعادة إدخال أمر مشروع.
  if (input.apiKey !== undefined && input.apiKey.trim().length > 0 && input.apiKey.trim().length < 8) {
    return "المفتاح قصير بغير منطق — تأكد من نسخه كاملًا.";
  }
  return null;
}

/** يحفظ التغييرات ويسجّلها في التدقيق — دون أن يلمس أي قيمة حسّاسة في السجل. */
export async function saveAiSettings(
  input: AiSettingsInput,
  actor: string,
  actorRole?: string | null,
): Promise<void> {
  const base = input.baseUrl.trim();
  const model = input.model.trim();
  // المفتاح الجديد يُشفَّر هنا وحده: النص الصريح لا يمرّ بمتغير آخر ولا يُطبع.
  // وإذا لم يُرسل مفتاح جديد فحقل المفتاح NULL فيُبقى على المحفوظ بـ COALESCE.
  const newKeyEnc = input.apiKey && input.apiKey.trim().length > 0
    ? encryptSecret(input.apiKey.trim())
    : null;

  await getPool().query(
    `INSERT INTO ai_settings (id, enabled, provider, base_url, model, api_key_enc, updated_by, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       provider = EXCLUDED.provider,
       base_url = EXCLUDED.base_url,
       model = EXCLUDED.model,
       api_key_enc = COALESCE(EXCLUDED.api_key_enc, ai_settings.api_key_enc),
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [input.enabled, input.provider, base, model, newKeyEnc, actor],
  );

  // تفاصيل التدقيق: المفاتيح لا القيم — يكفي للسؤال «من غيّر إعدادات الخدمة؟»
  // بلا نقل أي سرّ إلى سجل لا يُحذف منه.
  await recordAudit({
    action: "ai.settings.update",
    entity: "ai_settings",
    entityId: "1",
    entityLabel: AI_PROVIDER_LABEL[input.provider],
    details: {
      enabled: input.enabled,
      provider: input.provider,
      model,
      key_changed: Boolean(input.apiKey && input.apiKey.trim().length > 0),
    },
    actor,
    actorRole: actorRole ?? null,
  });
}

// ─── حارس الخصوصية ───────────────────────────────────────────────────────────

/**
 * يزيل الأنماط الصريحة للهوية قبل أي خروج نحو خدمة خارجية.
 *
 * حاجزٌ أخير لا بديل عن تأديب مَن يستدعي: الوحدات السريرية تبني النص من حقول
 * مجرّدة أصلًا، لكن خطأً برمجيًا واحدًا في مستقبل بعيد لا يرسل اسم مريض
 * إلى مزوّد خارجي. الأرقام المتتابعة (هواتف، ملفات، هويات) والبريد تُزال
 * لا تُنبَّه عليها — لأن ما فات التنبيه فات.
 */
export function sanitizeForPrivacy(text: string): string {
  return text
    // أرقام من 5 خانات فأكثر: هواتف، ملفات، هويات. أقل من ذلك قيمٌ سريرية مشروعة
    // (سنوات ميلاد، زوايا، قياسات) — فلا تُمسّ حتى لا يفسد الاقتراح نفسه.
    .replace(/[\d\u0660-\u0669]{5,}/g, "•••")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "•••");
}

// ─── الاستدعاء ───────────────────────────────────────────────────────────────

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatResult {
  ok: boolean;
  content: string;
  model: string;
  latencyMs: number;
  error?: string;
}

interface AiChatOptions {
  messages: AiChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** يُحقن في الاختبارات — لا يمرّ استدعاء حقيقي من الاختبار إطلاقًا. */
  fetchImpl?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * استدعاء «إكمال المحادثة» نحو المزوّد المضبوط.
 *
 * لا يُسمى إلا من مسار يعرض الناتج على مستخدم يعتمده بنفسه — هذه الوحدة لا
 * تكتب في أي جدول سريري أو مالي، ولا تعتمد شيئًا، ولا تفعل شيئًا يُدعى «قرارًا».
 */
export async function aiChat(options: AiChatOptions, config?: AiSettingsRow): Promise<AiChatResult> {
  const started = Date.now();
  const settings = config ?? await getAiSettings();

  if (!settings.enabled) {
    return { ok: false, content: "", model: settings.model, latencyMs: 0, error: "الخدمة غير ممكّنة من الإعدادات." };
  }
  if (!settings.apiKeyEnc) {
    return { ok: false, content: "", model: settings.model, latencyMs: 0, error: "لا يوجد مفتاح محفوظ." };
  }

  let apiKey: string;
  try {
    apiKey = decryptSecret(settings.apiKeyEnc);
  } catch {
    return { ok: false, content: "", model: settings.model, latencyMs: 0, error: "تعذّر فك تشفير المفتاح — أعد إدخاله من الإعدادات." };
  }

  // الحاجز الأخير: تعقيم كل محتوى يخرج نحو المزوّد.
  const messages = options.messages.map((message) => ({
    ...message,
    content: message.role === "system" ? message.content : sanitizeForPrivacy(message.content),
  }));

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    const response = await doFetch(joinUrl(settings.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = (await response.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string }
      | null;

    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? `رمز الاستجابة ${response.status}`;
      return { ok: false, content: "", model: settings.model, latencyMs: Date.now() - started, error: `رفض المزوّد الطلب: ${detail}` };
    }
    const content = payload?.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return { ok: false, content: "", model: settings.model, latencyMs: Date.now() - started, error: "أعاد المزوّد ناتجًا فارغًا." };
    }
    return { ok: true, content, model: settings.model, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطأ غير معروف";
    return { ok: false, content: "", model: settings.model, latencyMs: Date.now() - started, error: `تعذّر الوصول إلى الخدمة: ${message}` };
  }
}

// ─── اختبار الاتصال ──────────────────────────────────────────────────────────

export interface AiTestOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

/**
 * اختبار اتصال حقيقي بأصغر طلب ممكن، ويُثبَّت نتيجته في الصف نفسه
 * حتى يرى المالك متى عمل المفتاح آخر مرة.
 */
export async function testAiConnection(
  input: { apiKey?: string | undefined },
  actor: string,
  actorRole?: string | null,
  fetchImpl?: typeof fetch,
): Promise<AiTestOutcome> {
  const settings = await getAiSettings();
  const result = await aiChat(
    {
      messages: [
        { role: "system", content: "أداة فحص اتصال. أجب بكلمة واحدة فقط: جاهز." },
        { role: "user", content: "فحص" },
      ],
      maxTokens: 16,
      temperature: 0,
      timeoutMs: 20_000,
      fetchImpl,
    },
    // إن أُرسل مفتاح جديدًا لم يُحفظ بعد — نختبر به قبل الحفظ حتى لا يضطر المالك
    // إلى حفظ مفتاح خاطئ ليعرف أنه خاطئ.
    input.apiKey && input.apiKey.trim().length > 0
      ? { ...settings, apiKeyEnc: encryptSecret(input.apiKey.trim()) }
      : settings,
  );

  const outcome: AiTestOutcome = {
    ok: result.ok,
    message: result.ok ? `الاتصال ناجح — النموذج ${result.model} (${result.latencyMs} م.ث)` : (result.error ?? "فشل الاتصال."),
    latencyMs: result.latencyMs,
  };

  await getPool().query(
    `UPDATE ai_settings
     SET last_test_at = NOW(), last_test_ok = $1, last_test_message = $2
     WHERE id = 1`,
    [outcome.ok, outcome.message],
  );

  // في السجل: النتيجة والزمن فقط — لا مفتاح ولا بصمته.
  await recordAudit({
    action: "ai.test",
    entity: "ai_settings",
    entityId: "1",
    entityLabel: outcome.ok ? "ناجح" : "فاشل",
    details: { ok: outcome.ok, latency_ms: outcome.latencyMs, model: settings.model, with_new_key: Boolean(input.apiKey?.trim()) },
    actor,
    actorRole: actorRole ?? null,
  });

  return outcome;
}
