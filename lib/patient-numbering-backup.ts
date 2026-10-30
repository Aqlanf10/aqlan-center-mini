export const STANDALONE_BACKUP_SEQUENCES = [
  "patient_number_seq",
  "invoice_number_seq",
  "receipt_number_seq",
  "voucher_number_seq",
] as const;

export type StandaloneBackupSequence = (typeof STANDALONE_BACKUP_SEQUENCES)[number];

/** Preserve standalone sequence high-water in official SQL/full-archive backups.
 * Sequence reads are non-MVCC: observing a later value is conservative (a gap),
 * never an excuse to lower a restored allocator or reuse a retired identifier. */
export function standaloneSequenceRestoreSql(
  sequenceName: StandaloneBackupSequence,
  lastValue: unknown,
  isCalled: unknown,
): string {
  if (!(STANDALONE_BACKUP_SEQUENCES as readonly string[]).includes(sequenceName)) {
    throw new Error(`Unsupported standalone sequence: ${String(sequenceName)}`);
  }
  if (typeof lastValue !== "string" || !/^[1-9][0-9]{0,18}$/.test(lastValue)
    || BigInt(lastValue) > 9223372036854775807n || typeof isCalled !== "boolean") {
    throw new Error(`Invalid ${sequenceName} snapshot`);
  }
  return `SELECT setval('${sequenceName}', GREATEST(last_value, ${lastValue}::bigint), `
    + `(last_value > ${lastValue}::bigint OR (last_value = ${lastValue}::bigint AND is_called) OR ${isCalled})) FROM ${sequenceName};`;
}

export function patientNumberSequenceRestoreSql(lastValue: unknown, isCalled: unknown): string {
  return standaloneSequenceRestoreSql("patient_number_seq", lastValue, isCalled);
}
