/** Fixed-P application backup only. The archive still holds data, not schema
 * provisioning. Never choose a relation, SQL fragment or type from data. */
const pgBigintMax = "9223372036854775807";

export function patientNumberBackupSql(lastValue: unknown, isCalled: unknown): string {
  if (typeof lastValue !== "string" || !/^[1-9][0-9]{0,18}$/.test(lastValue)
    || (lastValue.length === 19 && lastValue > pgBigintMax) || typeof isCalled !== "boolean") {
    throw new Error("Invalid patient-number sequence snapshot");
  }
  const targetShape = `SELECT 1 FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
    WHERE s.seqrelid=pg_catalog.to_regclass('public.patient_number_seq') AND c.relpersistence='p'
      AND s.seqtypid='pg_catalog.int8'::pg_catalog.regtype AND s.seqincrement=1 AND s.seqcache=1
      AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND NOT s.seqcycle`;
  // Taking an ALTER SEQUENCE lock before reading prevents racing nextval on
  // this sequence. The no-op CACHE matches the approved shape; no archive
  // bytes configure it. RESTART is transactional unlike setval, including
  // marking one value called on the freshly restarted sequence storage.
  const body = `DECLARE present_value bigint; already_called boolean;
BEGIN
  IF NOT EXISTS (${targetShape}) THEN RAISE EXCEPTION 'Unsupported patient-number sequence'; END IF;
  ALTER SEQUENCE public.patient_number_seq CACHE 1;
  IF NOT EXISTS (${targetShape}) THEN RAISE EXCEPTION 'Unsupported patient-number sequence'; END IF;
  SELECT last_value, is_called INTO STRICT present_value, already_called FROM public.patient_number_seq;
  IF present_value < ${lastValue}::bigint OR
      (present_value = ${lastValue}::bigint AND NOT already_called AND ${isCalled}) THEN
    ALTER SEQUENCE public.patient_number_seq RESTART WITH ${lastValue};
    IF ${isCalled} THEN PERFORM pg_catalog.nextval('public.patient_number_seq'::pg_catalog.regclass); END IF;
  END IF;
END;`;
  // Standard SQL quoting is already supported by both restore entry points.
  // Dollar-quoted bodies are intentionally not accepted by the backup reader.
  return `DO '${body.replaceAll("'", "''")}';`;
}
