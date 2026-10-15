import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// A bundled, filesystem-free copy for Next standalone. The provenance test
// compares every byte with the immutable numbered files, including comments.
const names = ['0056_hr_employment_history.sql', '0057_hr_schedule_policy_versions.sql', '0058_hr_temporal_write_receipts.sql'];
const files = await Promise.all(names.map(async filename => {
  const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
  return { version: filename.slice(0, 4), name: filename.slice(5, -4), filename, sql,
    checksum: createHash('sha256').update(sql).digest('hex') };
}));
await writeFile(new URL('../lib/hr-temporal-schema.generated.json', import.meta.url), JSON.stringify(files, null, 2) + '\n');
