import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain-JS counterpart for the raw SQL CLI (which runs without a TS loader).
// The application paths use loadMigrationFiles; both derive checksums from the
// same published files and demand the original retired 0079 source.
export async function loadRestoreMigrationChecksums() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const rows = [];
  for (const filename of await readdir(dir)) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
    if (!match) continue;
    const checksum = createHash('sha256').update(await readFile(path.join(dir, filename))).digest('hex');
    rows.push({ version: match[1], name: match[2], filename, checksum });
  }
  rows.sort((a, b) => a.version.localeCompare(b.version));
  if (!rows.length || rows[0].version !== '0001' || new Set(rows.map(row => row.version)).size !== rows.length)
    throw new Error('Invalid restore migration source catalogue.');
  const historical = rows.find(row => row.version === '0079');
  if (!historical || historical.name !== 'ortho_followup_coverage'
      || historical.filename !== '0079_ortho_followup_coverage.sql'
      || historical.checksum !== '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99')
    throw new Error('Historical 0079 migration source missing or changed.');
  return rows;
}
