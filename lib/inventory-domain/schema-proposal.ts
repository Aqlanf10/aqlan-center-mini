/** Unnumbered, additive schema proposal. Root owns migration reservation and
 * registry/contracts. This is applied explicitly in isolated tests only; runtime
 * readiness checks never execute this SQL. No old rows, guards or debt is changed.
 */
export const INVENTORY_PROCUREMENT_SQL = String.raw`
CREATE TABLE IF NOT EXISTS inventory_locations (
  id TEXT PRIMARY KEY, branch_key TEXT NOT NULL,
  label TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('store','custody','transit')),
  doctor_party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK ((kind = 'custody') OR doctor_party_id IS NULL)
);
CREATE TABLE IF NOT EXISTS inventory_item_unit_versions (
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  entered_unit TEXT NOT NULL, base_unit TEXT NOT NULL,
  factor NUMERIC(18,9) NOT NULL CHECK (factor > 0),
  entered_precision INTEGER NOT NULL CHECK (entered_precision BETWEEN 0 AND 3),
  base_precision INTEGER NOT NULL CHECK (base_precision BETWEEN 0 AND 3),
  PRIMARY KEY(item_id,version),
  CHECK (entered_unit <> base_unit OR factor = 1)
);
CREATE TABLE IF NOT EXISTS inventory_approval_policies (
  id UUID PRIMARY KEY, branch_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  currency TEXT NOT NULL CHECK(currency='YER'),
  limit_minor BIGINT NOT NULL CHECK(limit_minor BETWEEN 0 AND 9007199254740991),
  allow_self_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(branch_key,version)
);
CREATE TABLE IF NOT EXISTS purchase_requests (
  id UUID PRIMARY KEY, branch_key TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','partially_approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS purchase_request_revisions (
  request_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  document JSONB NOT NULL CHECK(jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(request_id,version)
);
CREATE TABLE IF NOT EXISTS purchase_request_lines (
  request_id UUID NOT NULL, request_version INTEGER NOT NULL, id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  entered_qty NUMERIC(12,3) NOT NULL CHECK(entered_qty > 0),
  base_qty NUMERIC(12,3) NOT NULL CHECK(base_qty > 0),
  conversion JSONB NOT NULL CHECK(jsonb_typeof(conversion)='object'),
  PRIMARY KEY(request_id,request_version,id),
  FOREIGN KEY(request_id,request_version) REFERENCES purchase_request_revisions(request_id,version) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS purchase_approval_events (
  id UUID PRIMARY KEY, request_id UUID NOT NULL, request_version INTEGER NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision JSONB NOT NULL CHECK(jsonb_typeof(decision)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(request_id,request_version),
  FOREIGN KEY(request_id,request_version) REFERENCES purchase_request_revisions(request_id,version) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY, branch_key TEXT NOT NULL,
  supplier_party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  id TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  ordered_base_qty NUMERIC(12,3) NOT NULL CHECK(ordered_base_qty > 0),
  PRIMARY KEY(order_id,id)
);
CREATE TABLE IF NOT EXISTS purchase_order_source_allocations (
  id TEXT PRIMARY KEY, order_id UUID NOT NULL, order_line_id TEXT NOT NULL,
  request_id UUID NOT NULL, request_version INTEGER NOT NULL, request_line_id TEXT NOT NULL,
  base_qty NUMERIC(12,3) NOT NULL CHECK(base_qty > 0),
  amount_minor BIGINT NOT NULL CHECK(amount_minor >= 0), currency TEXT NOT NULL CHECK(currency IN ('YER','SAR','USD')),
  base_amount_minor BIGINT NOT NULL CHECK(base_amount_minor >= 0),
  FOREIGN KEY(order_id,order_line_id) REFERENCES purchase_order_lines(order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(request_id,request_version,request_line_id) REFERENCES purchase_request_lines(request_id,request_version,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS goods_receipts (
  id UUID PRIMARY KEY, order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id TEXT PRIMARY KEY, receipt_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL, order_line_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted','quarantined','rejected')),
  base_qty NUMERIC(12,3) NOT NULL CHECK(base_qty > 0),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  FOREIGN KEY(order_id,order_line_id) REFERENCES purchase_order_lines(order_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS stock_lots (
  id UUID PRIMARY KEY, receipt_line_id TEXT UNIQUE REFERENCES goods_receipt_lines(id) ON DELETE RESTRICT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  lot_code TEXT, expiry_date DATE,
  status TEXT NOT NULL CHECK(status IN ('accepted','quarantined','recalled')),
  cost_status TEXT NOT NULL CHECK(cost_status IN ('known','estimated','missing')),
  cost_snapshot JSONB NOT NULL CHECK(jsonb_typeof(cost_snapshot)='object'),
  CHECK (receipt_line_id IS NOT NULL OR cost_snapshot->>'source' = 'legacy_reconciliation')
);
CREATE TABLE IF NOT EXISTS quarantine_dispositions (
  id UUID PRIMARY KEY,
  receipt_line_id TEXT NOT NULL REFERENCES goods_receipt_lines(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  order_line_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('release','reject_return')),
  base_qty NUMERIC(12,3) NOT NULL CHECK(base_qty > 0),
  movement_id INTEGER UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(order_id,order_line_id) REFERENCES purchase_order_lines(order_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS inventory_movement_allocations (
  id UUID PRIMARY KEY, movement_id INTEGER NOT NULL REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES stock_lots(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  qty NUMERIC(12,3) NOT NULL CHECK(qty > 0),
  UNIQUE(movement_id,lot_id,location_id)
);
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id UUID PRIMARY KEY, order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  supplier_party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  duplicate_key TEXT UNIQUE,
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  match_plan JSONB NOT NULL CHECK(jsonb_typeof(match_plan)='object'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS supplier_invoice_payable_links (
  invoice_id UUID PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
  payable_id INTEGER NOT NULL UNIQUE REFERENCES payables(id) ON DELETE RESTRICT,
  approved_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS supplier_invoice_receipt_allocations (
  id TEXT PRIMARY KEY, invoice_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
  invoice_line_id TEXT NOT NULL,
  receipt_line_id TEXT NOT NULL REFERENCES goods_receipt_lines(id) ON DELETE RESTRICT,
  base_qty NUMERIC(12,3) NOT NULL CHECK(base_qty > 0)
);
CREATE TABLE IF NOT EXISTS inventory_operations (
  scope TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(scope,actor_id,operation_key)
);
CREATE INDEX IF NOT EXISTS purchase_requests_actor_idx ON purchase_requests(requested_by,created_at DESC,id);
CREATE INDEX IF NOT EXISTS goods_receipt_lines_order_idx ON goods_receipt_lines(order_id,order_line_id);
CREATE INDEX IF NOT EXISTS quarantine_dispositions_receipt_idx ON quarantine_dispositions(receipt_line_id,action);
CREATE INDEX IF NOT EXISTS stock_lots_location_idx ON stock_lots(item_id,location_id,status,expiry_date);
CREATE OR REPLACE FUNCTION inventory_procurement_append_only() RETURNS TRIGGER AS $inv_append$
BEGIN RAISE EXCEPTION 'Posted procurement evidence is append-only'; END;
$inv_append$ LANGUAGE plpgsql;
DO $inv_guards$
DECLARE rel TEXT;
BEGIN
 FOREACH rel IN ARRAY ARRAY['inventory_approval_policies','inventory_item_unit_versions','purchase_request_revisions','purchase_request_lines',
 'purchase_approval_events','purchase_orders','purchase_order_lines','purchase_order_source_allocations',
 'goods_receipts','goods_receipt_lines','stock_lots','quarantine_dispositions','inventory_movement_allocations',
 'supplier_invoices','supplier_invoice_payable_links','supplier_invoice_receipt_allocations','inventory_operations'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=rel || '_immutable' AND tgrelid=to_regclass(rel)) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only()',rel || '_immutable',rel);
  END IF;
 END LOOP;
END;
$inv_guards$;
`;
