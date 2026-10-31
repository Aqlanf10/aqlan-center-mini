/** Preserve standalone sequence high-water in official SQL/full-archive backups.
 * Sequence reads are non-MVCC: observing a later value is conservative (a gap),
 * never an excuse to lower a restored allocator or reuse a retired identifier. */
export function patientNumberSequenceRestoreSql(lastValue: unknown, isCalled: unknown): string {
  if (typeof lastValue !== "string" || !/^[1-9][0-9]{0,18}$/.test(lastValue)
    || BigInt(lastValue)>9223372036854775807n || typeof isCalled !== "boolean") throw new Error("Invalid patient-number sequence snapshot");
  return `SELECT setval('patient_number_seq', GREATEST(last_value, ${lastValue}::bigint), `
    + `(last_value > ${lastValue}::bigint OR (last_value = ${lastValue}::bigint AND is_called) OR ${isCalled})) FROM patient_number_seq;`;
}
