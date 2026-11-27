-- Explicit rehearsal only. On managed recovery apply after migrations and
-- before replaying archived patients or the active policy, in one transaction.
LOCK TABLE public.patient_numbering_policy IN ACCESS EXCLUSIVE MODE;
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.patient_numbering_policy'::regclass
      AND conname = 'patient_numbering_managed_first_range') THEN
    ALTER TABLE public.patient_numbering_policy ADD CONSTRAINT patient_numbering_managed_first_range
      CHECK (first_number BETWEEN CASE WHEN prefix = 'P' THEN 7000 ELSE 1 END AND 999999999999999999);
    ALTER TABLE public.patient_numbering_policy DROP CONSTRAINT patient_numbering_policy_first_number_check;
  END IF;
END;
$policy$;

-- Unknown formats remain historical evidence. Only an exact canonical number
-- in another series can safely be excluded from the legacy P projection.
CREATE OR REPLACE FUNCTION public.aqlan_managed_canonical_prefix(stored text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT CASE WHEN stored COLLATE "C" ~ '^[A-Z]{1,6}-([0-9]{5}|[1-9][0-9]{5,17})$'
               AND split_part(stored, '-', 2) <> '00000'
              THEN split_part(stored, '-', 1) END;
$body$;
REVOKE ALL ON FUNCTION public.aqlan_managed_canonical_prefix(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aqlan_managed_canonical_prefix(text) TO recovery_app;

CREATE OR REPLACE FUNCTION public.aqlan_reconcile_inserted_patient_number() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  digits text;
  high bigint;
BEGIN
  IF public.aqlan_managed_canonical_prefix(NEW.patient_number) <> 'P' THEN RETURN NULL; END IF;
  digits := ltrim(regexp_replace(NEW.patient_number, '[^0-9]', '', 'g'), '0');
  IF digits = '' OR length(digits) > 19 OR
    (length(digits) = 19 AND digits COLLATE "C" > '9223372036854775807') THEN RETURN NULL; END IF;
  high := digits::bigint;
  IF EXISTS (SELECT FROM public.patient_number_seq WHERE high > last_value OR (high = last_value AND NOT is_called)) THEN
    PERFORM setval('public.patient_number_seq'::regclass, high, true);
  END IF;
  RETURN NULL;
END;
$body$;
