-- Proposal 0142: AI Governance Budget Policies & Append-Only Usage Ledger (Charter §21, TD-12)
-- Coordinated with MIGRATION_COORDINATION.md. Runtime detection via to_regclass('public.ai_budget_policies').

CREATE TABLE IF NOT EXISTS ai_budget_policies (
  scope                TEXT        PRIMARY KEY,
  monthly_limit_minor  BIGINT      NOT NULL CHECK (monthly_limit_minor >= 0),
  daily_limit_minor    BIGINT      NOT NULL CHECK (daily_limit_minor >= 0),
  currency             TEXT        NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'SAR', 'YER')),
  enabled              BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id                   BIGSERIAL   PRIMARY KEY,
  user_id              INTEGER     NOT NULL,
  username             TEXT        NOT NULL,
  role                 TEXT        NOT NULL,
  scope                TEXT        NOT NULL,
  provider_id          TEXT,
  model                TEXT,
  prompt_tokens        INTEGER     NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens    INTEGER     NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  estimated_cost_minor BIGINT      NOT NULL DEFAULT 0 CHECK (estimated_cost_minor >= 0),
  currency             TEXT        NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'SAR', 'YER')),
  local_only           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_ledger_scope_created_idx
  ON ai_usage_ledger (scope, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_ai_usage_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_usage_ledger is append-only and cannot be modified or deleted';
END;
$$;

DROP TRIGGER IF EXISTS ai_usage_ledger_immutable_trg ON ai_usage_ledger;
CREATE TRIGGER ai_usage_ledger_immutable_trg
  BEFORE UPDATE OR DELETE ON ai_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_usage_ledger_mutation();
