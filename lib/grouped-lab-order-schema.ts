/**
 * 0136 grouped lab orders (owner #483 6930647956, 6931868779, 6932010630); contract
 * docs/review/grouped-lab-order-0136-contract-20261117.md. Byte-identical to migrations/0136_grouped_lab_orders.sql.
 */
export const GROUPED_LAB_ORDER_SQL = String.raw`-- 0136: one lab order for any number of selected teeth from one invoice entry (owner #483 6930647956,
-- 6931868779, 6932010630). Additive only: no row rewrite, no data removal, published 0074 triggers unchanged.
-- Each tooth's lab price is a frozen, append-only snapshot owned by its order; members stay immutable.
ALTER TABLE lab_work_intents DROP CONSTRAINT IF EXISTS lab_work_intents_group_kind_check;
ALTER TABLE lab_work_intents ADD CONSTRAINT lab_work_intents_group_kind_check
  CHECK (group_kind IN ('single','bridge','grouped'));
ALTER TABLE lab_work_intents ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE lab_work_intents DROP CONSTRAINT IF EXISTS lab_work_intents_instructions_ok;
ALTER TABLE lab_work_intents ADD CONSTRAINT lab_work_intents_instructions_ok
  CHECK (instructions IS NULL OR (group_kind='grouped' AND length(btrim(instructions)) BETWEEN 1 AND 600));

CREATE OR REPLACE FUNCTION aqlan_lab_intent_instructions_frozen() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.instructions IS DISTINCT FROM OLD.instructions AND (OLD.state <> 'draft' OR OLD.initial_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'lab work instructions are immutable once the order exists';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lab_intent_instructions_frozen ON lab_work_intents;
CREATE TRIGGER lab_intent_instructions_frozen BEFORE UPDATE ON lab_work_intents
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_intent_instructions_frozen();

-- Settings mapping (owner 6932010630 item 1): each clinic service names its lab service; prices stay per lab.
ALTER TABLE services ADD COLUMN IF NOT EXISTS lab_service_id INTEGER REFERENCES lab_services(id) ON DELETE RESTRICT;

-- How the order's cost was obtained. NULL = an order outside the grouped path (unchanged behaviour).
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS pricing_state TEXT;
ALTER TABLE lab_orders DROP CONSTRAINT IF EXISTS lab_orders_pricing_state_ok;
ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_pricing_state_ok CHECK (pricing_state IS NULL OR pricing_state IN
  ('rule','missing_rule','missing_mapping','currency_mismatch','mixed_currency','manual'));

CREATE TABLE IF NOT EXISTS lab_order_member_prices (
  lab_order_id INTEGER NOT NULL REFERENCES lab_orders(id) ON DELETE NO ACTION,
  member_id UUID NOT NULL REFERENCES lab_work_members(id) ON DELETE NO ACTION,
  tooth_code INTEGER NOT NULL,
  lab_service_id INTEGER REFERENCES lab_services(id) ON DELETE RESTRICT,
  pricing_rule_id INTEGER REFERENCES lab_pricing_rules(id) ON DELETE RESTRICT,
  unit_cost_minor BIGINT CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  unit_cost_currency TEXT,
  state TEXT NOT NULL CHECK (state IN ('rule','missing_rule','missing_mapping')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (lab_order_id, member_id),
  CHECK ((state = 'rule') = (pricing_rule_id IS NOT NULL AND unit_cost_minor IS NOT NULL AND unit_cost_currency IS NOT NULL)),
  CHECK (state <> 'missing_mapping' OR lab_service_id IS NULL),
  CHECK (state <> 'missing_rule' OR lab_service_id IS NOT NULL)
);
DROP TRIGGER IF EXISTS lab_order_member_prices_append_only ON lab_order_member_prices;
CREATE TRIGGER lab_order_member_prices_append_only BEFORE UPDATE OR DELETE ON lab_order_member_prices
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_append_only();`;
