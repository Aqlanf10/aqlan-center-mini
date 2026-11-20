// One explicit legacy allocator. Do not infer history from patient rows or
// accept an archive-provided relation, type, SQL fragment, or numeric JS value.
const max = 9223372036854775807n;
export const patientNumberSequenceMarker = "-- aqlan-patient-number-sequence-v1";

export function parsePatientNumberSequence(lastValue, isCalled) {
  if (typeof lastValue !== "string" || !/^[1-9][0-9]{0,18}$/.test(lastValue)
    || BigInt(lastValue) > max || typeof isCalled !== "boolean") {
    throw new Error("Invalid patient-number sequence snapshot.");
  }
  return { lastValue, isCalled };
}

export function patientNumberSequenceBackupLine(lastValue, isCalled) {
  const state = parsePatientNumberSequence(lastValue, isCalled);
  return `${patientNumberSequenceMarker} ${state.lastValue} ${state.isCalled}\n`;
}

const expectedTargetShapeSql = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_sequence s
   JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
   WHERE s.seqrelid = pg_catalog.to_regclass('public.patient_number_seq')
     AND pg_catalog.pg_has_role(c.relowner, 'USAGE')
     AND seqtypid = 'pg_catalog.int8'::regtype
     AND seqincrement = 1 AND seqcache = 1 AND seqmin = 1
     AND seqmax = 9223372036854775807 AND NOT seqcycle
) AS supported`;

/**
 * Called only inside an official isolated replay transaction. PostgreSQL ALTER
 * SEQUENCE locks out nextval; repeat the shape check and read state after the
 * lock. A RESTART (unlike setval) changes sequence storage transactionally.
 * Consuming one value after RESTART marks it called on that transactional
 * storage; rolling back the replay restores the old counter.
 */
export async function restorePatientNumberSequence(client, snapshot) {
  if (snapshot === null) return "not-recorded";
  const state = parsePatientNumberSequence(snapshot.lastValue, snapshot.isCalled);
  async function assertShape() {
    const { rows } = await client.query(expectedTargetShapeSql);
    if (rows[0]?.supported !== true) throw new Error("Unexpected target patient-number sequence definition or ownership.");
  }
  await assertShape();
  // The accepted definition already has cache=1. Nothing is configured by
  // archive bytes, and concurrent DDL is not a supported restore operation.
  await client.query("ALTER SEQUENCE public.patient_number_seq CACHE 1");
  await assertShape();
  const { rows } = await client.query("SELECT last_value::text, is_called FROM public.patient_number_seq");
  const existing = parsePatientNumberSequence(rows[0]?.last_value, rows[0]?.is_called);
  const targetValue = BigInt(existing.lastValue), backupValue = BigInt(state.lastValue);
  if (backupValue > targetValue || (backupValue === targetValue && state.isCalled && !existing.isCalled)) {
    // Only a validated decimal bigint can enter this fixed DDL statement.
    await client.query(`ALTER SEQUENCE public.patient_number_seq RESTART WITH ${state.lastValue}`);
    if (state.isCalled) await client.query("SELECT pg_catalog.nextval('public.patient_number_seq')");
  }
  return "reconciled";
}
