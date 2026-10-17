/** Query-contract fixtures only: private, empty evidence tables, never public schema. */
export const CURRENCY_READ_TEMP_SCHEMA = `
 ALTER TABLE pg_temp.invoices ADD COLUMN IF NOT EXISTS invoice_number text;
 ALTER TABLE pg_temp.payments ADD COLUMN IF NOT EXISTS base_currency text;
 ALTER TABLE pg_temp.payments ADD COLUMN IF NOT EXISTS exchange_rate numeric;
 ALTER TABLE pg_temp.payments ADD COLUMN IF NOT EXISTS reversal_of_id integer;
 CREATE TEMP TABLE invoice_corrections(id integer,patient_id integer,original_currency text,currency text,original_invoice_id integer,corrected_invoice_id integer);
 CREATE TEMP TABLE invoice_settlement_reclassifications(id integer,correction_id integer,patient_id integer,source_currency text,target_currency text,source_invoice_ids integer[],created_at timestamptz);
 CREATE TEMP TABLE invoice_settlement_reclassification_events(id integer,reclassification_id integer,payment_id integer,direction integer,source_minor bigint,target_minor bigint,payment_snapshot jsonb,created_at timestamptz);
`;
