-- (P2-10) Stock purchases linked to the supplier and the payable created with them.
-- Body must remain byte-for-byte equal to STOCK_SUPPLIER_SQL after these comments.
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS payable_id INTEGER REFERENCES payables(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_payable_uniq
  ON inventory_movements (payable_id) WHERE payable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_movements_party_idx
  ON inventory_movements (party_id) WHERE party_id IS NOT NULL;
