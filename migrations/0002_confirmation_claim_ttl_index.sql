-- 0002 — AI Confirmation Claim TTL Index
-- فهرس على claimed_at لتنظيف صفوف الإقرار المنتهية: التنظيف الفرصي الحالي
-- (DELETE WHERE claimed_at < NOW() - INTERVAL '1 day') يمسح الجدول كاملًا
-- بلا فهرس في كل مرة يُختار فيها. الفهرس يجعل المسح الضوئي محدودًا بالصفوف
-- القديمة وحدها. إضافة بحتة — لا تغيّر أي سلوك قائم.
CREATE INDEX IF NOT EXISTS ai_confirmation_claims_claimed_at_idx
  ON ai_confirmation_claims (claimed_at);
