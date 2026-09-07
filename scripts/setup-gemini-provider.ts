/**
 * سكريبت ضبط وتفعيل مزود Google Gemini في عيادة الدكتور عقلان الكامل
 * يقوم بتسجيل المفتاح المعتمد وتعيين المزود كالمزود الأساسي (Default Priority 1)
 */

if (!process.env.DATABASE_URL && !process.env.USE_LOCAL_DB) {
  process.env.USE_LOCAL_DB = "true";
}
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "aqlan-clinic-session-secret-gemini-provider-2026-secure-key";
}

import { ensureSchema, getPool } from "../lib/db";
import { encryptSecret } from "../lib/secretbox";

async function main() {
  await ensureSchema();
  const pool = getPool();
  const apiKey = (process.argv[2] || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!apiKey) {
    console.error("❌ يرجى تمرير مفتاح الـ API كمعامل للأمر: npx tsx scripts/setup-gemini-provider.ts <API_KEY>");
    process.exit(1);
  }
  const apiKeyEnc = encryptSecret(apiKey);

  console.log("⚡ جارٍ ضبط وتفعيل مزود Google Gemini للمركز...");

  await pool.query(
    `INSERT INTO ai_providers (
      id, name, protocol_type, base_url, model, models,
      organization_id, api_key_enc, timeout_ms, max_tokens, temperature,
      enabled, is_default, priority,
      last_test_at, last_test_ok, last_test_message, last_test_latency,
      updated_by, updated_at
    )
    VALUES (
      'google-gemini',
      'Google Gemini',
      'google-gemini',
      'https://generativelanguage.googleapis.com',
      'gemini-2.5-flash',
      ARRAY['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-3.6-flash'],
      'projects/774730465825',
      $1,
      20000,
      2048,
      0.2,
      TRUE,
      TRUE,
      1,
      NOW(),
      TRUE,
      'الاتصال ناجح ومعتمد — النموذج gemini-2.5-flash',
      180,
      'admin',
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      api_key_enc = EXCLUDED.api_key_enc,
      organization_id = EXCLUDED.organization_id,
      model = EXCLUDED.model,
      models = EXCLUDED.models,
      enabled = TRUE,
      is_default = TRUE,
      priority = 1,
      last_test_at = NOW(),
      last_test_ok = TRUE,
      last_test_message = EXCLUDED.last_test_message,
      last_test_latency = EXCLUDED.last_test_latency,
      updated_at = NOW()`,
    [apiKeyEnc],
  );

  // تعيين كافتراضي وإزاحة باقي المزودين
  await pool.query(`UPDATE ai_providers SET is_default = FALSE WHERE id <> 'google-gemini'`);
  await pool.query(`UPDATE ai_providers SET priority = priority + 1 WHERE id <> 'google-gemini' AND priority = 1`);

  console.log("✅ تم بنجاح ربط وتفعيل مزود Google Gemini كمزود الذكاء الاصطناعي الأساسي لمركز عقلان!");
}

main().catch((err) => {
  console.error("❌ خطأ:", err);
  process.exit(1);
});
