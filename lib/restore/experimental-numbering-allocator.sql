-- Explicit rehearsal overlay; install after all historical rows are restored and
-- old writers have been fenced. Only P continues to mirror the legacy sequence.
ALTER FUNCTION public.aqlan_managed_canonical_prefix(text) OWNER TO recovery_numbering_bridge;
-- During restore the app role can be the original function owner. Transfer
-- ownership before granting it the EXECUTE needed by the deferred trigger.
GRANT EXECUTE ON FUNCTION public.aqlan_managed_canonical_prefix(text) TO recovery_app;

CREATE FUNCTION numbering_bridge.local_consumed(requested_prefix text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  high bigint;
  ambiguous boolean;
  too_large boolean;
BEGIN
  IF requested_prefix IS NULL OR requested_prefix COLLATE "C" !~ '^[A-Z]{1,6}$' THEN
    RAISE EXCEPTION 'Invalid numbering series' USING ERRCODE = '22023';
  END IF;
  WITH identifiers AS (
    SELECT patient_number FROM public.patients
    UNION ALL SELECT patient_number FROM public.patient_number_retirements
  ), projected AS (
    SELECT public.aqlan_managed_canonical_prefix(patient_number) AS series,
           ltrim(regexp_replace(patient_number, '[^0-9]', '', 'g'), '0') AS digits,
           patient_number
    FROM identifiers
  )
  SELECT coalesce(max(CASE WHEN length(digits) BETWEEN 1 AND 18 THEN digits::bigint END), 0),
    coalesce(bool_or(series IS NULL AND
      (requested_prefix <> 'P' OR octet_length(patient_number) <> length(patient_number))), false),
    coalesce(bool_or(length(digits) > 18), false)
    INTO high, ambiguous, too_large FROM projected WHERE series = requested_prefix OR series IS NULL;
  -- Unclassified historical identifiers require reconciliation for custom series.
  -- For P, preserve the old ASCII digit projection, refusing ambiguous non-ASCII.
  IF ambiguous THEN RAISE EXCEPTION 'Unreconciled historical patient number' USING ERRCODE = '55000'; END IF;
  IF too_large THEN RAISE EXCEPTION 'Historical number exceeds authority range' USING ERRCODE = '2200H'; END IF;
  IF requested_prefix = 'P' THEN
    SELECT greatest(high, CASE WHEN is_called THEN last_value ELSE 0 END)
      INTO STRICT high FROM public.patient_number_seq;
  END IF;
  RETURN high;
END;
$body$;
ALTER FUNCTION numbering_bridge.local_consumed(text) OWNER TO recovery_numbering_bridge;
REVOKE ALL ON FUNCTION numbering_bridge.local_consumed(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA numbering_bridge TO recovery_app;
GRANT EXECUTE ON FUNCTION numbering_bridge.local_consumed(text) TO recovery_app;

-- One private marker for each INSERT statement; only numbers confirmed by the
-- authority within this statement can be attached to a new patient. Standalone
-- reservations burn at the authority and create no file-creation capability.
CREATE TABLE numbering_bridge.patient_insert_claims (
  transaction_id xid8 NOT NULL,
  trigger_depth integer NOT NULL,
  patient_number text COLLATE "C" NOT NULL,
  PRIMARY KEY (transaction_id, trigger_depth, patient_number)
);
ALTER TABLE numbering_bridge.patient_insert_claims OWNER TO recovery_numbering_bridge;
REVOKE ALL ON numbering_bridge.patient_insert_claims FROM PUBLIC, recovery_app;

CREATE OR REPLACE FUNCTION public.aqlan_begin_patient_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF TG_RELID <> 'public.patients'::regclass OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Invalid patient INSERT context' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aqlan.patient_number.write', 0));
  INSERT INTO numbering_bridge.patient_insert_claims VALUES (pg_current_xact_id(), pg_trigger_depth(), '');
  RETURN NULL;
END;
$body$;
ALTER FUNCTION public.aqlan_begin_patient_insert() OWNER TO recovery_numbering_bridge;
REVOKE ALL ON FUNCTION public.aqlan_begin_patient_insert() FROM PUBLIC, recovery_app;

CREATE OR REPLACE FUNCTION public.aqlan_next_patient_number() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  chosen text;
  policy_floor bigint;
  consumed bigint;
  pending numeric;
  confirmed text;
  reserved bigint;
  reply_types_valid boolean;
  full_number text;
  maximum CONSTANT bigint := 999999999999999999;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Patient allocation needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  LOCK TABLE public.patients IN ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('aqlan.patient_number.write', 0));
  SELECT prefix, first_number INTO chosen, policy_floor FROM public.patient_numbering_policy WHERE singleton;
  IF NOT FOUND THEN chosen := 'P'; policy_floor := 7000; END IF;
  consumed := numbering_bridge.local_consumed(chosen);
  pending := greatest(policy_floor, consumed::numeric + 1);
  IF chosen = 'P' THEN
    SELECT greatest(pending, 7000, last_value) INTO STRICT pending FROM public.patient_number_seq;
  END IF;
  IF pending > maximum THEN RAISE EXCEPTION 'Patient number exceeds authority range' USING ERRCODE = '2200H'; END IF;
  SELECT reply.confirmed_prefix, reply.reserved_number,
         pg_typeof(reply.confirmed_prefix) = 'text'::regtype AND pg_typeof(reply.reserved_number) = 'bigint'::regtype
    INTO STRICT confirmed, reserved, reply_types_valid
    FROM numbering_bridge.reserve(chosen, consumed, pending::bigint) AS reply;
  IF NOT reply_types_valid OR confirmed COLLATE "C" IS DISTINCT FROM chosen
       OR reserved IS NULL OR reserved < pending OR reserved > maximum THEN
    RAISE EXCEPTION 'Invalid independent reservation' USING ERRCODE = '55000';
  END IF;
  IF chosen = 'P' THEN
    PERFORM setval('public.patient_number_seq'::regclass, reserved, true);
  END IF;
  full_number := chosen || '-' || lpad(reserved::text, greatest(5, length(reserved::text)), '0');
  INSERT INTO numbering_bridge.patient_insert_claims
    SELECT transaction_id, trigger_depth, full_number FROM numbering_bridge.patient_insert_claims
    WHERE transaction_id = pg_current_xact_id() AND trigger_depth = pg_trigger_depth() + 1 AND patient_number = '';
  RETURN full_number;
END;
$body$;

CREATE OR REPLACE FUNCTION public.aqlan_guard_patient_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF TG_RELID <> 'public.patients'::regclass THEN RAISE EXCEPTION 'Invalid patient table'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.patient_number IS DISTINCT FROM OLD.patient_number THEN
      RAISE EXCEPTION 'Historical patient number is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  DELETE FROM numbering_bridge.patient_insert_claims
    WHERE transaction_id = pg_current_xact_id() AND trigger_depth = pg_trigger_depth()
      AND patient_number <> '' AND patient_number = NEW.patient_number COLLATE "C";
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient number requires a fresh reservation in this INSERT' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT FROM public.patient_number_retirements WHERE patient_number = NEW.patient_number) THEN
    RAISE EXCEPTION 'Patient number is retired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION public.aqlan_guard_patient_number() OWNER TO recovery_numbering_bridge;
REVOKE ALL ON FUNCTION public.aqlan_guard_patient_number() FROM PUBLIC, recovery_app;

CREATE FUNCTION numbering_bridge.end_patient_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF TG_RELID <> 'public.patients'::regclass THEN RAISE EXCEPTION 'Invalid patient table'; END IF;
  DELETE FROM numbering_bridge.patient_insert_claims
    WHERE transaction_id = pg_current_xact_id() AND trigger_depth = pg_trigger_depth();
  RETURN NULL;
END;
$body$;
ALTER FUNCTION numbering_bridge.end_patient_insert() OWNER TO recovery_numbering_bridge;
REVOKE ALL ON FUNCTION numbering_bridge.end_patient_insert() FROM PUBLIC, recovery_app;
CREATE TRIGGER patient_number_insert_end AFTER INSERT ON public.patients
  FOR EACH STATEMENT EXECUTE FUNCTION numbering_bridge.end_patient_insert();
