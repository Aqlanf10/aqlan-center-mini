/** Unnumbered allocation/transfer evidence, applied explicitly in isolated tests.
 * Clinic quantity remains SUM(existing inventory_movements). Transfers relocate
 * allocations of that quantity and create no clinic quantity/debt/cash entry.
 */
export const INVENTORY_CUSTODY_SQL = String.raw`
CREATE TABLE IF NOT EXISTS inventory_transfers (
  id UUID PRIMARY KEY, from_location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  to_location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  transit_location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(from_location_id <> to_location_id AND from_location_id <> transit_location_id AND to_location_id <> transit_location_id)
);
CREATE TABLE IF NOT EXISTS inventory_transfer_lines (
  id UUID PRIMARY KEY, transfer_id UUID NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  qty NUMERIC(12,3) NOT NULL CHECK(qty>0),
  cost_snapshot JSONB NOT NULL CHECK(jsonb_typeof(cost_snapshot)='object'),
  UNIQUE(transfer_id,lot_id)
);
CREATE TABLE IF NOT EXISTS inventory_transfer_acknowledgements (
  id UUID PRIMARY KEY, transfer_id UUID NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS inventory_transfer_ack_lines (
  acknowledgement_id UUID NOT NULL REFERENCES inventory_transfer_acknowledgements(id) ON DELETE RESTRICT,
  transfer_line_id UUID NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE RESTRICT,
  accepted_qty NUMERIC(12,3) NOT NULL CHECK(accepted_qty>=0),
  returned_qty NUMERIC(12,3) NOT NULL CHECK(returned_qty>=0),
  CHECK(accepted_qty+returned_qty>0),
  PRIMARY KEY(acknowledgement_id,transfer_line_id)
);
CREATE INDEX IF NOT EXISTS inventory_transfers_destination_idx ON inventory_transfers(to_location_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS custody_waste_approvals (
  id UUID PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  doctor_party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  max_qty NUMERIC(12,3) NOT NULL CHECK(max_qty>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  approved_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS custody_usage_events (
  id UUID PRIMARY KEY,
  usage_key TEXT NOT NULL UNIQUE CHECK(length(trim(usage_key)) BETWEEN 1 AND 240),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  store_location_id TEXT REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  movement_id INTEGER REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('consumed','approved_waste','returned_to_store')),
  qty NUMERIC(12,3) NOT NULL CHECK(qty>0),
  quantity_state TEXT NOT NULL CHECK(quantity_state IN ('confirmed','estimated')),
  patient_id TEXT,
  visit_id TEXT,
  case_id TEXT,
  procedure_id TEXT,
  waste_approval_id TEXT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  cost_snapshot JSONB NOT NULL CHECK(jsonb_typeof(cost_snapshot)='object'),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((kind='returned_to_store' AND store_location_id IS NOT NULL AND store_location_id <> location_id AND movement_id IS NULL)
     OR (kind IN ('consumed','approved_waste') AND store_location_id IS NULL AND movement_id IS NOT NULL)),
  CHECK(kind <> 'approved_waste' OR (waste_approval_id IS NOT NULL AND length(trim(waste_approval_id)) > 0))
);
CREATE TABLE IF NOT EXISTS custody_stocktakes (
  id UUID PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  expected_qty NUMERIC(12,3) NOT NULL CHECK(expected_qty>=0),
  counted_qty NUMERIC(12,3) NOT NULL CHECK(counted_qty>=0),
  difference_qty NUMERIC(12,3) NOT NULL,
  review_required BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS custody_package_closures (
  id UUID PRIMARY KEY,
  package_id TEXT NOT NULL UNIQUE CHECK(length(trim(package_id)) BETWEEN 1 AND 240),
  evidence_event_id TEXT NOT NULL UNIQUE CHECK(length(trim(evidence_event_id)) BETWEEN 1 AND 240),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  hazard TEXT NOT NULL CHECK(hazard IN ('none','sharp','contaminated')),
  policy TEXT NOT NULL CHECK(policy IN ('safe_empty_return','safe_disposal_record','bulk_count','reusable_custody')),
  evidence_action TEXT NOT NULL CHECK(evidence_action IN ('receive_safe_empty_package','document_safe_disposal','measure_and_count','separate_reusable_return')),
  original_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(original_qty>=0),
  consumed_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(consumed_qty>=0),
  returned_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(returned_qty>=0),
  waste_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(waste_qty>=0),
  remaining_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(remaining_qty>=0),
  unexplained_atoms BIGINT NOT NULL,
  review_required BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS custody_annual_settlements (
  id UUID PRIMARY KEY,
  doctor_party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  period_id TEXT NOT NULL CHECK(length(trim(period_id)) BETWEEN 1 AND 120),
  currency TEXT NOT NULL CHECK(currency IN ('YER','SAR','USD')),
  applied_deductions_minor BIGINT NOT NULL CHECK(applied_deductions_minor>=0),
  attributable_consumption_minor BIGINT,
  supplemental_minor BIGINT,
  direction TEXT NOT NULL CHECK(direction IN ('due_to_doctor','proposed_from_doctor','balanced','undetermined')),
  status TEXT NOT NULL CHECK(status IN ('ready_for_authorized_review','provisional')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS custody_settlement_objections (
  id UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES custody_annual_settlements(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $custody_guards$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY[
   'inventory_transfers','inventory_transfer_lines','inventory_transfer_acknowledgements','inventory_transfer_ack_lines',
   'custody_waste_approvals','custody_usage_events','custody_stocktakes','custody_package_closures','custody_annual_settlements','custody_settlement_objections'
 ] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=rel || '_immutable' AND tgrelid=to_regclass(rel)) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only()',rel || '_immutable',rel);
  END IF;
 END LOOP;
END;
$custody_guards$;
`;

