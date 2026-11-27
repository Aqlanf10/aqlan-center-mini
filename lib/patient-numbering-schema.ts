import { counterIdentifierBigintSql } from "./counter-identifier-sql";

/**
 * Acquires an ACCESS EXCLUSIVE DDL lock on `patient_number_seq` until commit
 * without changing its approved catalog shape (`CACHE 1`).
 */
export const PATIENT_COUNTER_LOCK_SQL = "ALTER SEQUENCE public.patient_number_seq CACHE 1";

/**
 * Opt-in patient numbering policy and retirement schema for controlled staging
 * rehearsals and synthetic recovery verification. Not applied automatically by
 * `ensureSchema()` while runtime numbering activation remains locked on the
 * current 66-migration baseline.
 */
export const PATIENT_NUMBERING_POLICY_SCHEMA_SQL = `
CREATE TABLE public.patient_numbering_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  prefix text COLLATE "C" NOT NULL CHECK (prefix ~ '^[A-Z]{1,6}$'),
  first_number bigint NOT NULL CONSTRAINT patient_numbering_policy_first_number_check
    CHECK (first_number BETWEEN 7000 AND 9223372036854775807)
);

CREATE TABLE public.patient_number_retirements (
  patient_number text PRIMARY KEY,
  patient_id integer,
  retired_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.aqlan_begin_patient_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  RETURN NULL;
END;
$body$;

CREATE TRIGGER patient_number_insert_begin
  BEFORE INSERT ON public.patients
  FOR EACH STATEMENT EXECUTE FUNCTION public.aqlan_begin_patient_insert();

CREATE OR REPLACE FUNCTION public.aqlan_guard_patient_number() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.patient_number IS DISTINCT FROM OLD.patient_number THEN
    RAISE EXCEPTION 'Historical patient number is immutable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT FROM public.patient_number_retirements WHERE patient_number = NEW.patient_number) THEN
    RAISE EXCEPTION 'Patient number is retired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER patient_number_guard
  BEFORE INSERT OR UPDATE OF patient_number ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.aqlan_guard_patient_number();

CREATE OR REPLACE FUNCTION public.aqlan_reconcile_inserted_patient_number() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  high bigint;
BEGIN
  SELECT ${counterIdentifierBigintSql("patient_number")} INTO high
    FROM (SELECT NEW.patient_number AS patient_number) inserted_row;
  IF high IS NOT NULL AND EXISTS (
    SELECT FROM public.patient_number_seq
    WHERE high > last_value OR (high = last_value AND NOT is_called)
  ) THEN
    PERFORM pg_catalog.setval('public.patient_number_seq'::regclass, high, true);
  END IF;
  RETURN NULL;
END;
$body$;

CREATE TRIGGER patient_number_reconcile_insert
  AFTER INSERT ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.aqlan_reconcile_inserted_patient_number();

CREATE OR REPLACE FUNCTION public.aqlan_next_patient_number() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  chosen text;
  floor_val bigint;
  issued bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Patient allocation needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  LOCK TABLE public.patients IN ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('aqlan.patient_number.write', 0));
  SELECT prefix, first_number INTO chosen, floor_val FROM public.patient_numbering_policy WHERE singleton;
  IF NOT FOUND THEN chosen := 'P'; floor_val := 7000; END IF;
  IF EXISTS (SELECT FROM public.patient_number_seq WHERE last_value < floor_val) THEN
    PERFORM pg_catalog.setval('public.patient_number_seq'::regclass, floor_val, false);
  END IF;
  issued := pg_catalog.nextval('public.patient_number_seq'::regclass);
  RETURN chosen || '-' || lpad(issued::text, greatest(5, length(issued::text)), '0');
END;
$body$;
`;
