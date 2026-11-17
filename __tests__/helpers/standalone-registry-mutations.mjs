/** Synthetic witness only. Mutate a single exact historical registry row. */
export function registryMutations(record) {
  if (typeof record !== 'string' || !record.includes("'ortho_followup_coverage'")
      || !record.includes('5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99')
      || !/'2025-03-04T05:06:07\.123456[^']*'/.test(record) || !/, FALSE\);$/.test(record)) {
    throw new Error('Unexpected synthetic historical registry record');
  }
  return {
    'wrong-name':record.replace("'ortho_followup_coverage'", "'incorrect_coverage'"),
    'wrong-checksum':record.replace('5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99','a'.repeat(64)),
    adopted:record.replace(/, FALSE\);$/, ', TRUE);'),
    'invalid-time':record.replace(/'2025-03-04T05:06:07\.123456[^']*'/, "'2025-99-99T77:99:99Z'"),
    '0090-missing-fields':`${record}\nINSERT INTO schema_migrations ("version", "checksum") VALUES ('0090', '${'a'.repeat(64)}');`,
  };
}
