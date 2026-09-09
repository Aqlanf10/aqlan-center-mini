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

      const payload = (await response.json().catch(() => null)) as any;

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

      const payload = (await response.json().catch(() => null)) as any;

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

      const payload = (await response.json().catch(() => null)) as any;

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

// ─── مصفوفة موحدة للمحولات ───────────────────────────────────────────────────

export function getProviderAdapter(protocolType: AiProtocolType): AIProviderAdapter {
  switch (protocolType) {
    case "anthropic-compatible":
      return new AnthropicCompatibleAdapter();
    case "google-gemini":
      return new GoogleGeminiAdapter();
    case "openai-compatible":
    case "openai-responses":
    case "custom-http":
    default:
      return new OpenAiCompatibleAdapter();
  }
}
