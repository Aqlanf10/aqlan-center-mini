/**
 * سجل مزودي الذكاء الاصطناعي المركزي (Dynamic AI Provider Registry)
 *
 * يتولى:
 * 1. إدارة المزودين وحفظهم مشفرين في قاعدة البيانات
 * 2. السلسلة الاحتياطية الذكية (Fallback Chain Execution)
 * 3. حماية وتشفير المفاتيح وعدم كشفها للواجهة
 * 4. ربط المحولات (Adapters)
 */

import { getPool, recordAudit } from "../db";
import { encryptSecret, maskKey, decryptSecret } from "../secretbox";
import type {
  AiProviderConfig,
  AiProviderInput,
  AiProviderView,
  FallbackChatResult,
} from "./types";
import { getProviderAdapter } from "./adapters";
import type { AiChatMessage, AiChatOptions, AiTestOutcome } from "../ai";
import { generateDentalExpertReply } from "../dental-ai-engine";

// ─── 1. استرجاع المزودين والهجرة التلقائية ───────────────────────────────────

export async function listAiProviders(): Promise<AiProviderConfig[]> {
  const pool = getPool();

  // فحص ما إذا كان الجدول يحتوي على مزودين
  const { rows } = await pool.query<any>(`
    SELECT id, name, protocol_type, base_url, api_endpoint, model, models,
           api_key_enc, organization_id, custom_headers, timeout_ms, max_tokens,
           temperature, enabled, is_default, priority, task_models,
           last_test_at, last_test_ok, last_test_message, last_test_latency,
           created_at, updated_at, updated_by
    FROM ai_providers
    ORDER BY priority ASC, id ASC
  `);

  if (rows.length === 0) {
    // محاولة الهجرة التلقائية من ai_settings إن وُجدت
    await pool.query(`
      INSERT INTO ai_providers (
        id, name, protocol_type, base_url, model, models, api_key_enc,
        enabled, is_default, priority, created_at, updated_at
      )
      SELECT
        s.provider,
        CASE
          WHEN s.provider = 'zai' THEN 'Z.ai / GLM'
          WHEN s.provider = 'openai' THEN 'OpenAI'
          ELSE 'واجهة متوافقة (OpenAI-compatible)'
        END,
        'openai-compatible',
        s.base_url,
        s.model,
        ARRAY[s.model],
        s.api_key_enc,
        s.enabled,
        TRUE,
        1,
        NOW(),
        NOW()
      FROM ai_settings s
      WHERE s.id = 1
      ON CONFLICT (id) DO NOTHING;
    `).catch(() => null);

    const reload = await pool.query<any>(`
      SELECT id, name, protocol_type, base_url, api_endpoint, model, models,
             api_key_enc, organization_id, custom_headers, timeout_ms, max_tokens,
             temperature, enabled, is_default, priority, task_models,
             last_test_at, last_test_ok, last_test_message, last_test_latency,
             created_at, updated_at, updated_by
      FROM ai_providers
      ORDER BY priority ASC, id ASC
    `);

    return reload.rows.map(mapRowToConfig);
  }

  return rows.map(mapRowToConfig);
}

export async function getAiProvider(id: string): Promise<AiProviderConfig | null> {
  const { rows } = await getPool().query<any>(
    `SELECT * FROM ai_providers WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return mapRowToConfig(rows[0]);
}

function mapRowToConfig(row: any): AiProviderConfig {
  return {
    id: row.id,
    name: row.name,
    protocolType: row.protocol_type,
    baseUrl: row.base_url,
    apiEndpoint: row.api_endpoint ?? null,
    model: row.model,
    models: Array.isArray(row.models) ? row.models : (row.model ? [row.model] : []),
    apiKeyEnc: row.api_key_enc ?? null,
    organizationId: row.organization_id ?? null,
    customHeaders: typeof row.custom_headers === "object" ? row.custom_headers : {},
    timeoutMs: row.timeout_ms ?? 30000,
    maxTokens: row.max_tokens ?? 2048,
    temperature: Number(row.temperature ?? 0.2),
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    priority: Number(row.priority ?? 10),
    taskModels: typeof row.task_models === "object" ? row.task_models : {},
    lastTestAt: row.last_test_at ? new Date(row.last_test_at) : null,
    lastTestOk: row.last_test_ok !== null ? Boolean(row.last_test_ok) : null,
    lastTestMessage: row.last_test_message ?? null,
    lastTestLatency: row.last_test_latency ? Number(row.last_test_latency) : null,
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    updatedBy: row.updated_by ?? null,
  };
}

export function toAiProviderView(config: AiProviderConfig): AiProviderView {
  let keyMasked = "";
  if (config.apiKeyEnc) {
    try {
      keyMasked = maskKey(decryptSecret(config.apiKeyEnc));
    } catch {
      keyMasked = "•••••••• (محفوظ)";
    }
  }

  return {
    id: config.id,
    name: config.name,
    protocolType: config.protocolType,
    baseUrl: config.baseUrl,
    apiEndpoint: config.apiEndpoint ?? null,
    model: config.model,
    models: config.models,
    hasKey: Boolean(config.apiKeyEnc),
    keyMasked,
    organizationId: config.organizationId ?? null,
    customHeaders: config.customHeaders ?? {},
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    enabled: config.enabled,
    isDefault: config.isDefault,
    priority: config.priority,
    taskModels: config.taskModels ?? {},
    lastTestAt: config.lastTestAt ? config.lastTestAt.toISOString() : null,
    lastTestOk: config.lastTestOk ?? null,
    lastTestMessage: config.lastTestMessage ?? null,
    lastTestLatency: config.lastTestLatency ?? null,
    createdAt: config.createdAt ? config.createdAt.toISOString() : null,
    updatedAt: config.updatedAt ? config.updatedAt.toISOString() : null,
    updatedBy: config.updatedBy ?? null,
  };
}

// ─── 2. التحقق والحفظ ─────────────────────────────────────────────────────────

export function validateProviderInput(input: AiProviderInput): string | null {
  const id = input.id?.trim();
  if (!id || !/^[a-z0-9-_]{2,50}$/i.test(id)) {
    return "معرف المزود الداخلي (ID) يجب أن يحتوي على حروف لاتينية وأرقام وشرطات فقط (2-50 حرفاً).";
  }
  const name = input.name?.trim();
  if (!name || name.length < 2 || name.length > 100) {
    return "اسم المزود يجب ألا يقل عن حرفين ولا يزيد عن 100 حرف.";
  }
  const allowedProtocols = [
    "openai-compatible",
    "openai-responses",
    "anthropic-compatible",
    "google-gemini",
    "custom-http",
  ];
  if (!input.protocolType || !allowedProtocols.includes(input.protocolType)) {
    return "نوع بروتوكول المزود غير مدعوم.";
  }
  const base = input.baseUrl?.trim();
  if (!base || !/^https?:\/\/.+/.test(base)) {
    return "عنوان Base URL يجب أن يبدأ بـ http:// أو https://.";
  }
  const model = input.model?.trim();
  if (!model || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) {
    return "اسم النموذج الافتراضي غير صالح (1-120 حرفاً).";
  }
  if (input.apiKey !== undefined && input.apiKey.trim().length > 0 && input.apiKey.trim().length < 4) {
    return "مفتاح API قصير جداً.";
  }
  if (input.timeoutMs !== undefined && (input.timeoutMs < 1000 || input.timeoutMs > 120000)) {
    return "مهلة الاتصال (Timeout) يجب أن تتراوح بين 1000 و 120000 مللي ثانية.";
  }
  if (input.maxTokens !== undefined && (input.maxTokens < 1 || input.maxTokens > 128000)) {
    return "أقصى عدد للرموز (Max Tokens) يجب أن يكون بين 1 و 128000.";
  }
  if (input.temperature !== undefined && (input.temperature < 0 || input.temperature > 2)) {
    return "درجة العشوائية (Temperature) يجب أن تكون بين 0 و 2.";
  }
  return null;
}

export async function saveAiProvider(
  input: AiProviderInput,
  actor: string,
  actorRole?: string | null,
): Promise<AiProviderConfig> {
  const pool = getPool();
  const id = input.id.trim().toLowerCase();
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const models = input.models && input.models.length > 0 ? input.models : [model];

  let newKeyEnc: string | null = null;
  if (input.apiKey && input.apiKey.trim().length > 0) {
    newKeyEnc = encryptSecret(input.apiKey.trim());
  }

  const isDefault = input.isDefault === true;
  if (isDefault) {
    // إلغاء تعيين كافتراضي عن باقي المزودين
    await pool.query(`UPDATE ai_providers SET is_default = FALSE WHERE id <> $1`, [id]);
  }

  const result = await pool.query(
    `INSERT INTO ai_providers (
       id, name, protocol_type, base_url, api_endpoint, model, models,
       api_key_enc, organization_id, custom_headers, timeout_ms, max_tokens,
       temperature, enabled, is_default, priority, task_models,
       updated_by, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       protocol_type = EXCLUDED.protocol_type,
       base_url = EXCLUDED.base_url,
       api_endpoint = EXCLUDED.api_endpoint,
       model = EXCLUDED.model,
       models = EXCLUDED.models,
       api_key_enc = COALESCE(EXCLUDED.api_key_enc, ai_providers.api_key_enc),
       organization_id = EXCLUDED.organization_id,
       custom_headers = EXCLUDED.custom_headers,
       timeout_ms = EXCLUDED.timeout_ms,
       max_tokens = EXCLUDED.max_tokens,
       temperature = EXCLUDED.temperature,
       enabled = EXCLUDED.enabled,
       is_default = EXCLUDED.is_default,
       priority = EXCLUDED.priority,
       task_models = EXCLUDED.task_models,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      id,
      name,
      input.protocolType || "openai-compatible",
      baseUrl,
      input.apiEndpoint?.trim() || null,
      model,
      models,
      newKeyEnc,
      input.organizationId?.trim() || null,
      JSON.stringify(input.customHeaders || {}),
      input.timeoutMs ?? 30000,
      input.maxTokens ?? 2048,
      input.temperature ?? 0.2,
      input.enabled !== false,
      isDefault,
      input.priority ?? 10,
      JSON.stringify(input.taskModels || {}),
      actor,
    ],
  );

  // تحديث ai_settings القديم إن كان هذا هو المزود الافتراضي (للتوافق الرجعي الكامل)
  if (isDefault) {
    await pool.query(
      `UPDATE ai_settings
       SET provider = $1, base_url = $2, model = $3,
           api_key_enc = COALESCE($4, api_key_enc),
           enabled = $5, updated_at = NOW()
       WHERE id = 1`,
      [id, baseUrl, model, newKeyEnc, input.enabled !== false],
    ).catch(() => null);
  }

  await recordAudit({
    action: "ai.provider.save",
    entity: "ai_providers",
    entityId: id,
    entityLabel: name,
    details: {
      providerId: id,
      name,
      protocol: input.protocolType,
      model,
      isDefault,
      enabled: input.enabled !== false,
      keyChanged: Boolean(newKeyEnc),
    },
    actor,
    actorRole: actorRole ?? null,
  });

  return mapRowToConfig(result.rows[0]);
}

export async function deleteAiProvider(
  id: string,
  actor: string,
  actorRole?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  const pool = getPool();
  const existing = await getAiProvider(id);
  if (!existing) {
    return { ok: false, message: "المزود غير موجود." };
  }

  const all = await listAiProviders();
  if (all.length <= 1) {
    return { ok: false, message: "لا يمكن حذف المزود الوحيد في النظام." };
  }

  await pool.query(`DELETE FROM ai_providers WHERE id = $1`, [id]);

  // إذا حُذف المزود الافتراضي، تعيين المزود الأول بدلاً منه
  if (existing.isDefault) {
    await pool.query(`
      UPDATE ai_providers
      SET is_default = TRUE
      WHERE id = (SELECT id FROM ai_providers ORDER BY priority ASC LIMIT 1)
    `);
  }

  await recordAudit({
    action: "ai.provider.delete",
    entity: "ai_providers",
    entityId: id,
    entityLabel: existing.name,
    details: { providerId: id, name: existing.name },
    actor,
    actorRole: actorRole ?? null,
  });

  return { ok: true };
}

export async function reorderAiProviders(
  orderedIds: string[],
  actor: string,
): Promise<void> {
  const pool = getPool();
  for (let idx = 0; idx < orderedIds.length; idx++) {
    const pId = orderedIds[idx];
    const priority = idx + 1;
    await pool.query(
      `UPDATE ai_providers SET priority = $1 WHERE id = $2`,
      [priority, pId],
    );
  }

  await recordAudit({
    action: "ai.providers.reorder",
    entity: "ai_providers",
    entityId: "order",
    entityLabel: "إعادة ترتيب الأولويات الاحتياطية",
    details: { orderedIds },
    actor,
  });
}

// ─── 3. اختبار الاتصال بالمزود ───────────────────────────────────────────────

export async function testAiProviderConnection(
  id: string,
  unsavedApiKey?: string,
  actor: string = "system",
  actorRole?: string | null,
  fetchImpl?: typeof fetch,
): Promise<AiTestOutcome> {
  const provider = await getAiProvider(id);
  if (!provider) {
    return { ok: false, message: "المزود غير موجود.", latencyMs: 0 };
  }

  const testConfig: AiProviderConfig = {
    ...provider,
    apiKeyEnc: unsavedApiKey && unsavedApiKey.trim().length > 0
      ? encryptSecret(unsavedApiKey.trim())
      : provider.apiKeyEnc,
  };

  const adapter = getProviderAdapter(testConfig.protocolType);
  const outcome = await adapter.testConnection(testConfig, fetchImpl);

  // تحديث حالة الاختبار في الجدول
  await getPool().query(
    `UPDATE ai_providers
     SET last_test_at = NOW(),
         last_test_ok = $1,
         last_test_message = $2,
         last_test_latency = $3
     WHERE id = $4`,
    [outcome.ok, outcome.message, outcome.latencyMs, id],
  );

  await recordAudit({
    action: "ai.provider.test",
    entity: "ai_providers",
    entityId: id,
    entityLabel: provider.name,
    details: {
      providerId: id,
      ok: outcome.ok,
      latencyMs: outcome.latencyMs,
      message: outcome.message,
    },
    actor,
    actorRole: actorRole ?? null,
  });

  return outcome;
}

// ─── 4. السلسلة الاحتياطية (Fallback Chain Execution) ─────────────────────────

export async function executeAiChatWithFallback(
  options: AiChatOptions,
  fetchImpl?: typeof fetch,
): Promise<FallbackChatResult> {
  const started = Date.now();
  const providers = await listAiProviders().catch(() => []);
  const enabledProviders = providers.filter((p) => p.enabled);

  const fallbackChainUsed: string[] = [];

  // ترتيب المزودين: الافتراضي أولاً إن وجد، ثم الأولوية التصاعدية
  const sorted = [...enabledProviders].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.priority - b.priority;
  });

  for (const provider of sorted) {
    fallbackChainUsed.push(provider.name);
    const adapter = getProviderAdapter(provider.protocolType);

    try {
      const result = await adapter.chat(
        {
          messages: options.messages,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          timeoutMs: options.timeoutMs ?? provider.timeoutMs,
          fetchImpl,
        },
        provider,
      );

      if (result.ok && result.content.trim()) {
        return {
          ...result,
          providerId: provider.id,
          providerName: provider.name,
          fallbackChainUsed,
        };
      }
      // فشل المزود الحالي (رمز خطأ أو رصيد أو غيره) ➔ الانتقال للمزود التالي في السلسلة
    } catch {
      // استثناء شبكة أو timeout ➔ الانتقال للمزود التالي
    }
  }

  // 🛡️ الملاذ الأخير الحاسم: إذا فشلت كافة المزودات السحابية أو انعدمت المفاتيح،
  // يتم تفعيل المحرك السريري والإداري الداخلي المدمج بمركز عقلان لضمان عدم توقف النظام!
  fallbackChainUsed.push("Aqlan Internal Clinical Engine");
  const localReply = await generateDentalExpertReply(
    options.messages,
    {
      userRole: "admin",
      canViewAllPatients: true,
      canViewFinancials: true,
    },
  );

  return {
    ok: true,
    content: localReply.reply,
    model: `${localReply.model} (محرك المركز الداخلي الاحتياطي)`,
    latencyMs: Date.now() - started,
    providerId: "internal",
    providerName: "Aqlan Internal Engine",
    fallbackChainUsed,
    isInternalFallback: true,
  };
}
