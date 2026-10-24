-- Catalog-only, read-only prerequisite check for upgrading the deployed runtime (f2b5eef9) to the
-- completed-work candidate (c998b435), which registers 0066, 0068, 0069, then 0067.
--
-- Scope: PostgreSQL system catalogs, plus the 8-row migration registry (schema_migrations:
-- version, name, checksum, adopted). It reads NO patient, clinical or financial row, writes nothing,
-- takes no lock on any application table except an ACCESS SHARE on schema_migrations, and ends in
-- ROLLBACK. Each row is (check_id, ok, detail). Every ok must be true before a rollout is attempted.
-- "detail" carries only object names, definitions, counts and planner estimates.
--
-- This file is a specification artifact. It was validated only against local synthetic databases.
-- Running it anywhere else is a separate, explicitly authorized operation; it is not authorized here.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog, public;

WITH
expected_registry(version, name, checksum) AS (VALUES
  ('0051', 'ortho_treatment_strategy',          '44ff94771e962a48fa27d05de941e0c096d19000d66078a6fbe477ae4265157e'),
  ('0052', 'ortho_assessment',                  '92113a0e96c51edc5596508c9b40f742df5bff38b0e80518504034bd74acbae2'),
  ('0056', 'hr_employment_history',             'cc87396b7d3cd5035c67f1dfa0f2dedbe2ed904a618722b12b833c969cf7c112'),
  ('0057', 'hr_schedule_policy_versions',       '8e4bf0f0adf3d2284f64bd792b3903958ce6ed62923b4cb0c61ac405b82b8791'),
  ('0058', 'hr_temporal_write_receipts',        '1c2c0a3582cb5777fe6cf063d0ba5d1bbe04ef6acbbf035382a7fceeb9a6b972'),
  ('0063', 'invoice_currency_reclassification', '19adaec13af17f3e7d78a6656daa4516983a1ac5186e3a55609153146b3119c4'),
  ('0064', 'approved_agreement_principal',      'aefc040a29c8b887a8eeca073103ce4268a8851b89e0025b406941e48f247655'),
  ('0065', 'inventory_purchase_receipts',       '4b7c79f4ce7b334e0f052cbd73d7fd2346c91ed5200081551f1a9f0cfd4b7808')),
registry AS (
  SELECT version, name, checksum, adopted FROM public.schema_migrations
),
-- Every relation-namespace name the four files create (tables, implicit sequences, explicit and
-- implicit indexes). PostgreSQL would silently uniquify an implicit name; a clash still means the
-- resulting schema differs from the proven one, so any clash fails.
new_relations(relname, origin) AS (VALUES
  ('agreement_delta_amendments', '0066 table'),
  ('agreement_delta_amendments_id_seq', '0066 implicit sequence'),
  ('agreement_delta_amendments_pkey', '0066 implicit index'),
  ('agreement_delta_amendments_delta_invoice_id_key', '0066 implicit index'),
  ('agreement_delta_amendments_idempotency_key_key', '0066 implicit index'),
  ('agreement_delta_amendments_plan_time_idx', '0066 index'),
  ('agreement_delta_amendments_patient_time_idx', '0066 index'),
  ('agreement_delta_amendments_next_unique', '0066 index'),
  ('agreement_delta_attempt_rejections', '0066 table'),
  ('agreement_delta_attempt_rejections_pkey', '0066 implicit index'),
  ('agreement_delta_collection_receipts', '0066 table'),
  ('agreement_delta_collection_receipts_pkey', '0066 implicit index'),
  ('collection_attempt_retirements', '0068 table'),
  ('collection_attempt_retirements_pkey', '0068 implicit index'),
  ('collection_attempt_retirements_patient_idx', '0068 index'),
  ('appointments_patient_history_idx', '0067 index')),
-- CREATE TABLE also creates a composite type (and its array type) of the same name.
new_types(typname) AS (
  SELECT relname FROM new_relations WHERE origin LIKE '% table'
  UNION ALL SELECT '_' || relname FROM new_relations WHERE origin LIKE '% table'),
-- 0066 uses plain CREATE FUNCTION (an existing zero-argument function fails the file);
-- 0068/0069 use CREATE OR REPLACE (an existing one would be silently replaced). Both must be absent.
new_functions(proname, origin) AS (VALUES
  ('aqlan_agreement_delta_immutable', '0066 CREATE FUNCTION'),
  ('aqlan_agreement_delta_invoice_fence', '0066 CREATE FUNCTION'),
  ('aqlan_collection_key_fence', '0068 CREATE OR REPLACE FUNCTION'),
  ('aqlan_unpaid_currency_transition_guard', '0069 CREATE OR REPLACE FUNCTION')),
-- Triggers the files add to tables that already exist (triggers on the new tables are covered above).
new_triggers(relname, tgname, origin) AS (VALUES
  ('invoice_items', 'agreement_delta_item_fence', '0066'),
  ('invoices', 'agreement_delta_invoice_fence', '0066'),
  ('payments', 'collection_key_retirement_fence', '0068'),
  ('invoice_settlement_reclassifications', 'invoice_reclassification_direction_guard', '0069'),
  ('invoice_settlement_reclassification_events', 'invoice_reclassification_event_direction_guard', '0069')),
-- Keys the new foreign keys reference: each needs a single-column PRIMARY KEY or UNIQUE constraint on
-- "id" of an integer type (the referencing columns are INTEGER).
referenced_keys(relname) AS (VALUES
  ('patients'), ('treatment_plans'), ('plan_items'), ('clinical_cases'),
  ('invoices'), ('services'), ('parties'), ('users')),
-- Columns the new trigger functions and the new index read. PL/pgSQL bodies are not validated at
-- CREATE time: a missing column would surface later as a failed ordinary write, not as a failed file.
required_columns(relname, attname, typcategory, origin) AS (VALUES
  ('invoice_items', 'invoice_id', 'N', '0066 invoice fence'),
  ('invoice_items', 'plan_item_id', 'N', '0066 invoice fence'),
  ('invoice_items', 'source_type', 'S', '0066 invoice fence'),
  ('invoice_items', 'source_id', 'N', '0066 invoice fence'),
  ('plan_items', 'id', 'N', '0066 invoice fence'),
  ('plan_items', 'plan_id', 'N', '0066 invoice fence'),
  ('invoices', 'id', 'N', '0066 invoice fence / 0069 guard'),
  ('invoices', 'patient_id', 'N', '0066 invoice fence'),
  ('invoices', 'base_currency', 'S', '0066 invoice fence'),
  ('invoices', 'total_minor', 'N', '0066 invoice fence'),
  ('invoices', 'discount_minor', 'N', '0066 invoice fence'),
  ('invoices', 'plan_id', 'N', '0066 invoice fence'),
  ('invoices', 'created_at', 'D', '0066 invoice fence'),
  ('invoices', 'invoice_number', 'S', '0066 invoice fence'),
  ('invoices', 'status', 'S', '0066 invoice fence'),
  ('payments', 'idempotency_key', 'S', '0068 key fence'),
  ('payments', 'invoice_id', 'N', '0069 guard'),
  ('invoice_settlement_reclassifications', 'id', 'N', '0069 guard'),
  ('invoice_settlement_reclassifications', 'source_currency', 'S', '0069 constraint / guard'),
  ('invoice_settlement_reclassifications', 'target_currency', 'S', '0069 constraint / guard'),
  ('invoice_settlement_reclassifications', 'source_invoice_ids', 'A', '0069 guard (= ANY(array))'),
  ('invoice_settlement_reclassification_events', 'reclassification_id', 'N', '0069 guard'),
  ('appointments', 'id', 'N', '0067 index'),
  ('appointments', 'patient_id', 'N', '0067 index'),
  ('appointments', 'scheduled_date', 'D', '0067 index'),
  ('appointments', 'scheduled_time', 'D', '0067 index')),
-- 0069 drops these two by exact name in one ALTER TABLE; both are required, validated, and their
-- definitions logically imply the new direction CHECK (YER, SAR are allowed and distinct), so the
-- validation scan of the new CHECK cannot fail on existing rows.
old_checks(conname, expected_def) AS (VALUES
  ('invoice_settlement_reclassifications_source_currency_check', 'CHECK ((source_currency = ''YER''::text))'),
  ('invoice_settlement_reclassifications_target_currency_check', 'CHECK ((target_currency = ''SAR''::text))')),
rel AS (
  SELECT c.oid, c.relname, c.relkind, c.reltuples FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
),
checks AS (
  -- Server ------------------------------------------------------------------------------------------
  SELECT 10 AS ord, 'server.version' AS check_id,
         current_setting('server_version_num')::int >= 110000 AS ok,
         'server_version=' || current_setting('server_version') || ' (EXECUTE FUNCTION and hashtextextended need >= 11)' AS detail
  UNION ALL
  SELECT 11, 'server.not_in_recovery', NOT pg_is_in_recovery(),
         CASE WHEN pg_is_in_recovery() THEN 'connected to a standby' ELSE 'primary' END
  -- Registry ----------------------------------------------------------------------------------------
  UNION ALL
  SELECT 20, 'registry.exactly_eight',
         (SELECT count(*) FROM registry) = 8
           AND NOT EXISTS (SELECT version FROM registry EXCEPT SELECT version FROM expected_registry),
         'registered=' || coalesce((SELECT string_agg(version, ',' ORDER BY version) FROM registry), '(none)')
  UNION ALL
  SELECT 21, 'registry.names_and_checksums_match_published',
         NOT EXISTS (SELECT 1 FROM expected_registry e LEFT JOIN registry r USING (version)
                     WHERE r.version IS NULL OR r.name <> e.name OR r.checksum <> e.checksum),
         coalesce((SELECT 'mismatch=' || string_agg(e.version, ',' ORDER BY e.version)
                   FROM expected_registry e LEFT JOIN registry r USING (version)
                   WHERE r.version IS NULL OR r.name <> e.name OR r.checksum <> e.checksum), 'all 8 match')
  UNION ALL
  SELECT 22, 'registry.none_adopted', NOT EXISTS (SELECT 1 FROM registry WHERE adopted),
         'adopted=' || (SELECT count(*) FROM registry WHERE adopted)
  UNION ALL
  SELECT 23, 'registry.candidate_versions_absent',
         NOT EXISTS (SELECT 1 FROM registry WHERE version IN ('0066', '0067', '0068', '0069')),
         coalesce((SELECT 'present=' || string_agg(version, ',' ORDER BY version) FROM registry
                   WHERE version IN ('0066', '0067', '0068', '0069')), 'none present')
  -- New-object conflicts ----------------------------------------------------------------------------
  UNION ALL
  SELECT 30, 'conflict.relation_names', NOT EXISTS (SELECT 1 FROM new_relations n JOIN rel r USING (relname)),
         coalesce((SELECT 'existing=' || string_agg(n.relname || '[' || r.relkind::text || ', ' || n.origin || ']', '; ' ORDER BY n.relname)
                   FROM new_relations n JOIN rel r USING (relname)), 'none of 16 names exist')
  UNION ALL
  SELECT 31, 'conflict.type_names',
         NOT EXISTS (SELECT 1 FROM new_types n JOIN pg_type t ON t.typname = n.typname AND t.typnamespace = 'public'::regnamespace),
         coalesce((SELECT 'existing=' || string_agg(n.typname, ',' ORDER BY n.typname)
                   FROM new_types n JOIN pg_type t ON t.typname = n.typname AND t.typnamespace = 'public'::regnamespace), 'none exist')
  UNION ALL
  SELECT 32, 'conflict.functions',
         NOT EXISTS (SELECT 1 FROM new_functions f JOIN pg_proc p ON p.proname = f.proname AND p.pronamespace = 'public'::regnamespace),
         coalesce((SELECT 'existing=' || string_agg(p.oid::regprocedure::text || ' [' || f.origin || ']', '; ' ORDER BY p.proname)
                   FROM new_functions f JOIN pg_proc p ON p.proname = f.proname AND p.pronamespace = 'public'::regnamespace), 'none of 4 exist')
  UNION ALL
  SELECT 33, 'conflict.triggers_on_existing_tables',
         NOT EXISTS (SELECT 1 FROM new_triggers n JOIN rel r USING (relname) JOIN pg_trigger t ON t.tgrelid = r.oid AND t.tgname = n.tgname),
         coalesce((SELECT 'existing=' || string_agg(n.relname || '.' || n.tgname, ',' ORDER BY n.relname)
                   FROM new_triggers n JOIN rel r USING (relname) JOIN pg_trigger t ON t.tgrelid = r.oid AND t.tgname = n.tgname), 'none of 5 exist')
  UNION ALL
  SELECT 34, 'conflict.direction_check_name',
         NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_settlement_reclassifications_direction_check'
                     AND connamespace = 'public'::regnamespace),
         coalesce((SELECT 'existing on ' || conrelid::regclass::text FROM pg_constraint
                   WHERE conname = 'invoice_settlement_reclassifications_direction_check' AND connamespace = 'public'::regnamespace LIMIT 1), 'absent')
  -- Referenced keys ---------------------------------------------------------------------------------
  UNION ALL
  SELECT 40, 'keys.' || k.relname || '.id',
         r.oid IS NOT NULL AND a.atttypid IN ('int4'::regtype, 'int8'::regtype) AND EXISTS (
           SELECT 1 FROM pg_constraint con WHERE con.conrelid = r.oid AND con.contype IN ('p', 'u') AND con.conkey = ARRAY[a.attnum]),
         CASE WHEN r.oid IS NULL THEN 'table missing'
              WHEN a.attnum IS NULL THEN 'column id missing'
              ELSE 'type=' || format_type(a.atttypid, a.atttypmod) || ', key=' || coalesce((
                SELECT string_agg(con.conname || '(' || con.contype::text || ')', ',') FROM pg_constraint con
                WHERE con.conrelid = r.oid AND con.contype IN ('p', 'u') AND con.conkey = ARRAY[a.attnum]), 'NONE') END
  FROM referenced_keys k
  LEFT JOIN rel r ON r.relname = k.relname AND r.relkind IN ('r', 'p')
  LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = 'id' AND NOT a.attisdropped
  -- Columns read by the new functions and index ----------------------------------------------------
  UNION ALL
  SELECT 50, 'columns.' || c.relname || '.' || c.attname,
         a.attnum IS NOT NULL AND (CASE c.typcategory
           WHEN 'D' THEN t.typcategory::text = 'D'
           WHEN 'A' THEN t.typcategory::text = 'A' AND et.typcategory::text = 'N'
           ELSE t.typcategory::text = c.typcategory END),
         CASE WHEN a.attnum IS NULL THEN 'missing (' || c.origin || ')'
              ELSE format_type(a.atttypid, a.atttypmod) || ' (' || c.origin || ')' END
  FROM required_columns c
  LEFT JOIN rel r ON r.relname = c.relname AND r.relkind IN ('r', 'p')
  LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.attname AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
  -- appointments_patient_history_idx ---------------------------------------------------------------
  UNION ALL
  SELECT 60, 'appointments.index_name_absent', to_regclass('public.appointments_patient_history_idx') IS NULL,
         coalesce(to_regclass('public.appointments_patient_history_idx')::text, 'absent')
  UNION ALL
  -- An equivalent index under another name is not a failure (the file would build a redundant one);
  -- it is reported so the rollout can decide. ok=true means no equivalent exists.
  SELECT 61, 'appointments.no_equivalent_index',
         NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                     WHERE i.indrelid = to_regclass('public.appointments')
                       AND (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                            JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum)
                           = ARRAY['patient_id', 'scheduled_date', 'scheduled_time', 'id']
                       AND i.indpred IS NULL AND i.indexprs IS NULL),
         coalesce((SELECT 'equivalent=' || string_agg(ic.relname, ',') FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                   WHERE i.indrelid = to_regclass('public.appointments')
                     AND (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                          JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum)
                         = ARRAY['patient_id', 'scheduled_date', 'scheduled_time', 'id']
                     AND i.indpred IS NULL AND i.indexprs IS NULL), 'none')
  UNION ALL
  SELECT 62, 'appointments.no_invalid_index', NOT EXISTS (
           SELECT 1 FROM pg_index WHERE indrelid = to_regclass('public.appointments') AND NOT indisvalid),
         coalesce((SELECT 'invalid=' || string_agg(indexrelid::regclass::text, ',') FROM pg_index
                   WHERE indrelid = to_regclass('public.appointments') AND NOT indisvalid), 'none')
  -- Old currency CHECKs dropped by name by 0069 ----------------------------------------------------
  UNION ALL
  SELECT 70, 'currency.' || o.conname,
         con.oid IS NOT NULL AND con.contype = 'c' AND con.convalidated AND pg_get_constraintdef(con.oid) = o.expected_def,
         CASE WHEN con.oid IS NULL THEN 'missing: 0069 would fail after 0066 and 0068 committed'
              ELSE pg_get_constraintdef(con.oid) || ', validated=' || con.convalidated END
  FROM old_checks o
  LEFT JOIN pg_constraint con ON con.conrelid = to_regclass('public.invoice_settlement_reclassifications') AND con.conname = o.conname
  UNION ALL
  SELECT 71, 'currency.no_other_checks_on_currency_columns', NOT EXISTS (
           SELECT 1 FROM pg_constraint con
           WHERE con.conrelid = to_regclass('public.invoice_settlement_reclassifications') AND con.contype = 'c'
             AND con.conname NOT IN (SELECT conname FROM old_checks)
             AND con.conname <> 'invoice_settlement_reclassifications_source_invoice_ids_check'),
         coalesce((SELECT 'other=' || string_agg(con.conname || ' ' || pg_get_constraintdef(con.oid), '; ') FROM pg_constraint con
                   WHERE con.conrelid = to_regclass('public.invoice_settlement_reclassifications') AND con.contype = 'c'
                     AND con.conname NOT IN (SELECT conname FROM old_checks)
                     AND con.conname <> 'invoice_settlement_reclassifications_source_invoice_ids_check'), 'none')
  -- Lock planning: planner estimates only (pg_class.reltuples, relation size); no row is read -------
  UNION ALL
  SELECT 80, 'estimate.' || r.relname, true,
         CASE WHEN r.reltuples < 0 THEN 'reltuples=never analyzed' ELSE 'reltuples=' || r.reltuples::bigint END
           || ', size=' || pg_size_pretty(pg_total_relation_size(r.oid))
  FROM rel r
  WHERE r.relkind IN ('r', 'p') AND r.relname IN ('appointments', 'invoices', 'invoice_items', 'payments', 'patients',
        'treatment_plans', 'plan_items', 'clinical_cases', 'services', 'parties', 'users',
        'invoice_settlement_reclassifications', 'invoice_settlement_reclassification_events')
)
SELECT check_id, ok, detail FROM checks ORDER BY ord, check_id;

ROLLBACK;
