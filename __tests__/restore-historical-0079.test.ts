import { describe, expect, it } from 'vitest';
import { insertStatement } from '../lib/backup';
import { prepareBackupSql } from '../lib/restore/sql.mjs';

const checksum = '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99';
const row = (overrides: Record<string, unknown> = {}) => insertStatement('schema_migrations',
  ['version', 'name', 'checksum', 'applied_at', 'adopted'], {
    version: '0079', name: 'ortho_followup_coverage', checksum,
    applied_at: '2026-01-02T12:34:56.123456+00:00', adopted: false, ...overrides,
  });
const inspect = (body: string) => prepareBackupSql(`BEGIN;\n${body}\nCOMMIT;`, { inspectHistorical0079: true });

describe('historical coverage evidence in writer backup SQL', () => {
  it('extracts only an exact ledger row, retaining timestamp precision and excluding the row from replay', () => {
    const record = row();
    const prepared = inspect(record);
    expect(prepared.historical0079).toEqual({ appliedAt: '2026-01-02T12:34:56.123456+00:00' });
    expect(prepared.dataSql).not.toContain(record);
  });
  it('does not activate for comments or literal text resembling a ledger record', () => {
    expect(inspect(`-- ${row()}\nINSERT INTO example ("note") VALUES ('0079');`).historical0079).toBeNull();
  });
  it.each([
    row({ checksum: '0'.repeat(64) }), row({ name: 'other' }), row({ adopted: true }),
    `${row()}\n${row()}`, "INSERT INTO schema_migrations VALUES ('0079', 'ortho_followup_coverage');",
  ])('refuses ambiguous or altered source registry: %s', (record) => {
    expect(() => inspect(record)).toThrow();
  });
});
