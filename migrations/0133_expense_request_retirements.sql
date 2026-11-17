-- Expense request retirements: "nothing is recorded under this request key" made final for one request.
-- Review #483 6883224187; number allocated in #483 6883984936. Contract:
-- docs/finance/EXPENSE_REQUEST_RETIREMENTS_0133.md. Builds on 0128, which is not changed.
-- A retirement binds the key to the request fingerprint (0128 idempotency_request_hash) and the actor
-- (expenses.created_by). Both sides take the 0128 per-key transaction lock, so the check and the write
-- cannot interleave: saved first, the retirement is refused; retired first, that request writes nothing.
-- A request with another fingerprint or actor is not fenced. Permanent history: no update, no delete,
-- TRUNCATE only of an empty table.
CREATE TABLE expense_request_retirements (
 idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 retired_by TEXT NOT NULL CHECK (retired_by = btrim(retired_by) AND char_length(retired_by) BETWEEN 1 AND 200),
 retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION aqlan_expense_request_key_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'TRUNCATE' THEN
  IF NOT EXISTS (SELECT 1 FROM expense_request_retirements) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'expense_request_retirements سحب مفاتيح طلبات الصرف دائم (append-only): لا يُمسح.';
 END IF;
 IF TG_TABLE_NAME = 'expense_request_retirements' AND TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'expense_request_retirements سحب مفاتيح طلبات الصرف دائم (append-only): لا يُعدَّل ولا يُحذف.';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('aqlan.expense.request:' || NEW.idempotency_key, 0));
 IF TG_TABLE_NAME = 'expense_request_retirements' THEN
  IF EXISTS (SELECT 1 FROM expenses WHERE idempotency_key = NEW.idempotency_key) THEN
   RAISE EXCEPTION 'expense_request_retirements المفتاح يحمل سند صرف محفوظًا؛ لا يُسحب.';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM expense_request_retirements r WHERE r.idempotency_key = NEW.idempotency_key
   AND r.request_hash = NEW.idempotency_request_hash AND r.retired_by = NEW.created_by) THEN
  RAISE EXCEPTION 'expenses مفتاح طلب الصرف مسحوب لهذا الطلب؛ لا يُكتب سند.';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER expense_request_retirement_guard BEFORE INSERT OR UPDATE OR DELETE ON expense_request_retirements
 FOR EACH ROW EXECUTE FUNCTION aqlan_expense_request_key_fence();
CREATE TRIGGER expense_request_retirement_truncate BEFORE TRUNCATE ON expense_request_retirements
 FOR EACH STATEMENT EXECUTE FUNCTION aqlan_expense_request_key_fence();
CREATE TRIGGER expense_request_key_fence BEFORE INSERT ON expenses
 FOR EACH ROW WHEN (NEW.idempotency_key IS NOT NULL) EXECUTE FUNCTION aqlan_expense_request_key_fence();
