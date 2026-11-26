/**
 * محولات بروتوكولات مزودي الذكاء الاصطناعي (AI Provider Protocol Adapters)
 *
 * تنفذ معمارية المحولات (Adapter Pattern) بحيث لا يعرف البوت أسماء الشركات
 * بل يتعامل مع واجهات بروتوكول موحدة.
 */

import type { AiChatMessage, AiChatResult, AiTestOutcome } from "../ai";
import { sanitizeForPrivacy } from "../ai";
import { providerFailureCategory, sanitizeProviderDetail } from "../redact";
import { decryptSecret } from "../secretbox";
import { assertSafeOutboundUrl, sanitizeCustomHeaders } from "../safe-outbound-url";
import type { AIProviderAdapter, AiProviderConfig, AiProtocolType } from "./types";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * (P2/S7) بوابة SSRF الموحدة قبل كل نداء صادر: البنية + السياسة + DNS،
 * وترويسات المزود المخصصة معقّمة. لا محول ينسج fetch خارجها.
 * الفشل هنا رسالة مستخدم عربية (تظهر في اختبار الاتصال) لا استثناء.
 *
 * حين يُحقن fetchImpl فالمتصل يتحكم بالنقل (اختبار) — فحص DNS الحي يتخطاه
 * (بيئة الاختبار بلا شبكة أصلاً)، ويبقى فحص البنية والسياسة كاملاً: localhost
 * والمدى الخاص والبروتوكولات مقيدة حتى في الاختبارات. فحص DNS نفسه له
 * اختباراته المخصصة بحاقن resolveDns في ملف SSRF.
 */
async function guardOutbound(
  targetUrl: string,
  config: AiProviderConfig,
  options?: { fetchImpl?: typeof fetch },
): Promise<{ error: string } | { headers: Record<string, string> }> {
  const isProduction = process.env.NODE_ENV === "production";
  const outbound = await assertSafeOutboundUrl(targetUrl, {
    isProduction,
    ...(options?.fetchImpl ? { resolveDns: async () => ["203.0.113.10"] } : {}),
  });
  if (!outbound.ok) {
    return { error: `عنوان المزود مرفوض أمنيًا: ${outbound.reason ?? "غير صالح"}` };
  }
  const headerCheck = sanitizeCustomHeaders(config.customHeaders);
  if (!headerCheck.ok) {
    return { error: `ترويسات المزود مرفوضة: ${headerCheck.reason ?? "غير صالحة"}` };
  }
  return { headers: headerCheck.headers };
}

// ─── 1. محول OpenAI المتوافق (OpenAI, GLM, DeepSeek, Groq, Ollama) ─────────────

export class OpenAiCompatibleAdapter implements AIProviderAdapter {
  protocol: AiProtocolType = "openai-compatible";

  async chat(
    options: {
      messages: AiChatMessage[];
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
    config: AiProviderConfig,
  ): Promise<AiChatResult> {
    const started = Date.now();
    if (!config.apiKeyEnc && !config.baseUrl.includes("localhost") && !config.baseUrl.includes("127.0.0.1")) {
      return { ok: false, content: "", model: config.model, latencyMs: 0, error: "لا يوجد مفتاح محفوظ للمزود." };
    }

    let apiKey = "";
    if (config.apiKeyEnc) {
      try {
        apiKey = decryptSecret(config.apiKeyEnc);
      } catch {
        return { ok: false, content: "", model: config.model, latencyMs: 0, error: "تعذر فك تشفير المفتاح — أعد إدخاله." };
      }
    }

    const messages = options.messages.map((m) => ({
      ...m,
      content: m.role === "system" ? m.content : sanitizeForPrivacy(m.content),
    }));

    const endpoint = config.apiEndpoint || "/chat/completions";
    const targetUrl = joinUrl(config.baseUrl, endpoint);

    /* (P2/S7) لا fetch واحد يخرج قبل بوابة SSRF — redirect: "error" معه:
       تحويل المزود إلى مضيف آخر = وجهة لم تُتحقق، فنرفضها لا نتبعها. */
    const guard = await guardOutbound(targetUrl, config, options);
    if ("error" in guard) {
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: guard.error };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(config.organizationId ? { "OpenAI-Organization": config.organizationId } : {}),
      ...guard.headers,
    };

    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 30000;

    try {
      const response = await doFetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: options.maxTokens ?? config.maxTokens ?? 1024,
          temperature: options.temperature ?? config.temperature ?? 0.2,
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json().catch(() => null)) as { error?: { message?: string }; message?: string; choices?: { message?: { content?: string } }[] } | null;

      if (!response.ok) {
        /* (P2-FIX-4) تفصيلة المزود الخام تُعقَّم: بريئة ⇒ ملخص مُقيَّد،
           حاملة سرّ/مسار/رابط ⇒ التصنيف الآمن العام — لا رسالة خام. */
        const detail = sanitizeProviderDetail(payload?.error?.message ?? payload?.message);
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: `رفض المزوّد (${config.name}): ${providerFailureCategory(response.status)}${detail ? ` — ${detail}` : ""}` };
      }

      const content = payload?.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: `أعاد المزود (${config.name}) ناتجاً فارغاً.` };
      }

      return { ok: true, content, model: config.model, latencyMs: Date.now() - started };
    } catch (err) {
      const isTimeout = err instanceof Error
        && (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
      const detail = isTimeout ? null : sanitizeProviderDetail(err instanceof Error ? err.message : undefined);
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: isTimeout
        ? `انتهت مهلة الاتصال بـ (${config.name}).${detail ? ` — ${detail}` : ""}`
        : `تعذر الاتصال بـ (${config.name}).${detail ? ` — ${detail}` : ""}` };
    }
  }

  async testConnection(config: AiProviderConfig, fetchImpl?: typeof fetch): Promise<AiTestOutcome> {
    const result = await this.chat(
      {
        messages: [
          { role: "system", content: "أداة فحص اتصال. أجب بكلمة واحدة فقط: جاهز." },
          { role: "user", content: "فحص" },
        ],
        maxTokens: 16,
        temperature: 0,
        timeoutMs: 15000,
        fetchImpl,
      },
      config,
    );

    return {
      ok: result.ok,
      message: result.ok
        ? `الاتصال ناجح بـ ${config.name} — النموذج ${result.model} (${result.latencyMs} م.ث)`
        : (result.error ?? "فشل الاتصال بالمزود."),
      latencyMs: result.latencyMs,
    };
  }
}

// ─── 2. محول Anthropic Claude (Messages API) ──────────────────────────────────

export class AnthropicCompatibleAdapter implements AIProviderAdapter {
  protocol: AiProtocolType = "anthropic-compatible";

  async chat(
    options: {
      messages: AiChatMessage[];
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
    config: AiProviderConfig,
  ): Promise<AiChatResult> {
    const started = Date.now();
    if (!config.apiKeyEnc) {
      return { ok: false, content: "", model: config.model, latencyMs: 0, error: "لا يوجد مفتاح محفوظ لمزود Anthropic." };
    }

    let apiKey = "";
    try {
      apiKey = decryptSecret(config.apiKeyEnc);
    } catch {
      return { ok: false, content: "", model: config.model, latencyMs: 0, error: "تعذر فك تشفير المفتاح." };
    }

    // Anthropic يفصل نصوص الـ system في حقل مستقل
    let systemPrompt = "";
    const anthropicMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const m of options.messages) {
      if (m.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + m.content;
      } else {
        anthropicMessages.push({
          role: m.role,
          content: sanitizeForPrivacy(m.content),
        });
      }
    }

    const endpoint = config.apiEndpoint || "/v1/messages";
    const targetUrl = joinUrl(config.baseUrl, endpoint);

    const guard = await guardOutbound(targetUrl, config, options);
    if ("error" in guard) {
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: guard.error };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...guard.headers,
    };

    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 30000;

    try {
      const response = await doFetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          system: systemPrompt || undefined,
          messages: anthropicMessages,
          max_tokens: options.maxTokens ?? config.maxTokens ?? 1024,
          temperature: options.temperature ?? config.temperature ?? 0.2,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json().catch(() => null)) as { error?: { message?: string }; content?: { text?: string }[] } | null;

      if (!response.ok) {
        /* (P2-FIX-4) تعقيم تفصيلة المزود الخام قبل أي خروج أو تخزين. */
        const detail = sanitizeProviderDetail(payload?.error?.message);
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: `رفض Anthropic: ${providerFailureCategory(response.status)}${detail ? ` — ${detail}` : ""}` };
      }

      const content = payload?.content?.[0]?.text ?? "";
      if (!content.trim()) {
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: "أعاد Anthropic ناتجاً فارغاً." };
      }

      return { ok: true, content, model: config.model, latencyMs: Date.now() - started };
    } catch (err) {
      const isTimeout = err instanceof Error
        && (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
      const detail = isTimeout ? null : sanitizeProviderDetail(err instanceof Error ? err.message : undefined);
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: isTimeout
        ? `انتهت مهلة الاتصال بـ Anthropic.${detail ? ` — ${detail}` : ""}`
        : `تعذر الاتصال بـ Anthropic.${detail ? ` — ${detail}` : ""}` };
    }
  }

  async testConnection(config: AiProviderConfig, fetchImpl?: typeof fetch): Promise<AiTestOutcome> {
    const result = await this.chat(
      {
        messages: [{ role: "user", content: "فحص اتصال، أجب بكلمة: جاهز." }],
        maxTokens: 16,
        timeoutMs: 15000,
        fetchImpl,
      },
      config,
    );

    return {
      ok: result.ok,
      message: result.ok
        ? `الاتصال ناجح بـ ${config.name} — النموذج ${result.model} (${result.latencyMs} م.ث)`
        : (result.error ?? "فشل الاتصال بالمزود."),
      latencyMs: result.latencyMs,
    };
  }
}

// ─── 3. محول Google Gemini API ────────────────────────────────────────────────

export class GoogleGeminiAdapter implements AIProviderAdapter {
  protocol: AiProtocolType = "google-gemini";

  async chat(
    options: {
      messages: AiChatMessage[];
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
    config: AiProviderConfig,
  ): Promise<AiChatResult> {
    const started = Date.now();
    if (!config.apiKeyEnc) {
      return { ok: false, content: "", model: config.model, latencyMs: 0, error: "لا يوجد مفتاح محفوظ لمزود Gemini." };
    }

    let apiKey = "";
    try {
      apiKey = decryptSecret(config.apiKeyEnc);
    } catch {
      return { ok: false, content: "", model: config.model, latencyMs: 0, error: "تعذر فك تشفير المفتاح." };
    }

    let systemInstruction = "";
    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    for (const m of options.messages) {
      if (m.role === "system") {
        systemInstruction += (systemInstruction ? "\n" : "") + m.content;
      } else {
        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: sanitizeForPrivacy(m.content) }],
        });
      }
    }

    let endpoint = config.apiEndpoint?.trim()
      ? config.apiEndpoint.trim()
      : `/v1beta/models/${config.model}:generateContent`;
    if (!endpoint.includes("key=")) {
      endpoint += (endpoint.includes("?") ? "&" : "?") + `key=${encodeURIComponent(apiKey)}`;
    }
    const targetUrl = joinUrl(config.baseUrl, endpoint);

    const guard = await guardOutbound(targetUrl, config, options);
    if ("error" in guard) {
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: guard.error };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-goog-api-key": apiKey,
      ...guard.headers,
    };

    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 30000;

    try {
      const response = await doFetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            maxOutputTokens: options.maxTokens ?? config.maxTokens ?? 1024,
            temperature: options.temperature ?? config.temperature ?? 0.2,
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json().catch(() => null)) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;

      if (!response.ok) {
        /* (P2-FIX-4) تعقيم تفصيلة المزود الخام قبل أي خروج أو تخزين. */
        const detail = sanitizeProviderDetail(payload?.error?.message);
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: `رفض Gemini: ${providerFailureCategory(response.status)}${detail ? ` — ${detail}` : ""}` };
      }

      const content = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!content.trim()) {
        return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: "أعاد Gemini ناتجاً فارغاً." };
      }

      return { ok: true, content, model: config.model, latencyMs: Date.now() - started };
    } catch (err) {
      const isTimeout = err instanceof Error
        && (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
      const detail = isTimeout ? null : sanitizeProviderDetail(err instanceof Error ? err.message : undefined);
      return { ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error: isTimeout
        ? `انتهت مهلة الاتصال بـ Gemini.${detail ? ` — ${detail}` : ""}`
        : `تعذر الاتصال بـ Gemini.${detail ? ` — ${detail}` : ""}` };
    }
  }

  async testConnection(config: AiProviderConfig, fetchImpl?: typeof fetch): Promise<AiTestOutcome> {
    const result = await this.chat(
      {
        messages: [{ role: "user", content: "فحص اتصال، أجب بكلمة: جاهز." }],
        maxTokens: 16,
        timeoutMs: 15000,
        fetchImpl,
      },
      config,
    );

    return {
      ok: result.ok,
      message: result.ok
        ? `الاتصال ناجح بـ ${config.name} — النموذج ${result.model} (${result.latencyMs} م.ث)`
        : (result.error ?? "فشل الاتصال بالمزود."),
      latencyMs: result.latencyMs,
    };
  }
}


/** OpenAI Responses uses a different wire format from Chat Completions. */
export class OpenAiResponsesAdapter implements AIProviderAdapter {
  protocol: AiProtocolType = "openai-responses";

  async chat(options: Parameters<AIProviderAdapter["chat"]>[0], config: AiProviderConfig): Promise<AiChatResult> {
    const started = Date.now();
    const fail = (error: string): AiChatResult => ({
      ok: false, content: "", model: config.model, latencyMs: Date.now() - started, error,
    });
    if (!config.apiKeyEnc) return fail("لا يوجد مفتاح محفوظ لمزود OpenAI.");
    let apiKey: string;
    try {
      apiKey = decryptSecret(config.apiKeyEnc);
    } catch {
      return fail("تعذر فك تشفير المفتاح.");
    }
    const targetUrl = joinUrl(config.baseUrl, config.apiEndpoint || "/responses");
    const guard = await guardOutbound(targetUrl, config, options);
    if ("error" in guard) return fail(guard.error);
    const input = options.messages.map((m) => ({
      role: m.role === "system" ? "developer" : m.role,
      content: m.role === "system" ? m.content : sanitizeForPrivacy(m.content),
    }));
    try {
      // Headers.set replaces case-insensitive duplicates from custom headers.
      // A JSON body must not be sent with a conflicting content type or organization.
      const headers = new Headers(guard.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${apiKey}`);
      if (config.organizationId) headers.set("OpenAI-Organization", config.organizationId);
      const response = await (options.fetchImpl ?? fetch)(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model, input, store: false, stream: false,
          max_output_tokens: Math.max(16, options.maxTokens ?? config.maxTokens ?? 1024),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs ?? 30000),
      });
      const payload = await response.json().catch(() => null) as {
        status?: string; model?: string; error?: { message?: string }; incomplete_details?: unknown;
        output?: Array<{ type?: string; role?: string; status?: string; content?: Array<{ type?: string; text?: string }> }>;
      } | null;
      if (!response.ok) {
        const detail = sanitizeProviderDetail(payload?.error?.message);
        return fail(`رفض OpenAI: ${providerFailureCategory(response.status)}${detail ? ` — ${detail}` : ""}`);
      }
      // A completed status must not contradict an explicit error or incomplete-details record.
      if (payload?.status !== "completed" || payload.error != null || payload.incomplete_details != null) {
        return fail("لم يكتمل رد OpenAI.");
      }
      const messages = (Array.isArray(payload.output) ? payload.output : [])
        .filter((item) => item?.type === "message" && item.role === "assistant");
      // A refusal or incomplete assistant message must not be hidden by a separate READY text part.
      if (messages.some((item) => item.status !== "completed"
        || !Array.isArray(item.content) || item.content.length === 0
        || item.content.some((part) => part?.type !== "output_text" || typeof part.text !== "string"))) {
        return fail("تضمن رد OpenAI رفضًا أو رسالة غير مكتملة أو غير صالحة.");
      }
      const content = messages
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => part?.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text ?? "").join("\n").trim();
      if (!content) return fail("أعاد OpenAI ناتجاً فارغاً.");
      // Never present the requested model as verified response metadata.
      if (typeof payload.model !== "string" || !payload.model.trim()) {
        return fail("لم يحدد رد OpenAI النموذج الذي نفذ الطلب.");
      }
      return { ok: true, content, model: payload.model, latencyMs: Date.now() - started };
    } catch {
      return fail("تعذر الاتصال بـ OpenAI أو انتهت المهلة.");
    }
  }

  async testConnection(config: AiProviderConfig, fetchImpl?: typeof fetch): Promise<AiTestOutcome> {
    const result = await this.chat({
      messages: [{ role: "user", content: "Reply with READY only." }],
      maxTokens: 256,
      timeoutMs: 20000,
      fetchImpl,
    }, config);
    if (!result.ok || result.content.trim() !== "READY") {
      return {
        ok: false,
        message: result.error ?? "لم يُعد المزود علامة التحقق المطلوبة READY.",
        latencyMs: result.latencyMs,
      };
    }
    // The wire protocol alone is not proof of a direct OpenAI connection.
    const endpoint = new URL(joinUrl(config.baseUrl, config.apiEndpoint || "/responses"));
    const directOpenAi = endpoint.origin === "https://api.openai.com"
      && endpoint.pathname === "/v1/responses" && !endpoint.search;
    return {
      ok: true,
      message: directOpenAi
        ? `الاتصال ناجح بـ OpenAI — النموذج ${result.model}`
        : `نجح اختبار مزود متوافق مع Responses — النموذج ${result.model} (ليس اتصالاً مباشراً بـ OpenAI)`,
      latencyMs: result.latencyMs,
    };
  }
}

// ─── مصفوفة موحدة للمحولات ───────────────────────────────────────────────────

export function getProviderAdapter(protocolType: AiProtocolType): AIProviderAdapter {
  switch (protocolType) {
    case "anthropic-compatible":
      return new AnthropicCompatibleAdapter();
    case "google-gemini":
      return new GoogleGeminiAdapter();
    case "openai-responses":
      return new OpenAiResponsesAdapter();
    case "openai-compatible":
    case "custom-http":
    default:
      return new OpenAiCompatibleAdapter();
  }
}
