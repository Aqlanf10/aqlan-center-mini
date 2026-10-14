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
DO $custody_guards$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY['inventory_transfers','inventory_transfer_lines','inventory_transfer_acknowledgements','inventory_transfer_ack_lines'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=rel || '_immutable' AND tgrelid=to_regclass(rel)) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only()',rel || '_immutable',rel);
  END IF;
 END LOOP;
END;
$custody_guards$;
`;
