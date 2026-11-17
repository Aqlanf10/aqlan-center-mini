import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { checksumOf } from '../lib/migration-files';

afterEach(() => {
  vi.doUnmock('../lib/prescription-issuance-schema');
  vi.resetModules();
});

it.each(['file', 'embedded', 'both'] as const)(
  'rejects altered 0093 %s source before querying the database', async (changedPart) => {
  const original = readFileSync('migrations/0093_prescription_issuance_commands.sql', 'utf8');
  const changed = `${original}-- synthetic change\n`;
  vi.resetModules();
  vi.doMock('../lib/prescription-issuance-schema', () => ({
    PRESCRIPTION_ISSUANCE_SQL: changedPart === 'file' ? original : changed,
  }));
  const { PRESCRIPTION_ISSUANCE_MIGRATIONS, validatePrescriptionIssuanceMigration } = await import('../lib/prescription-issuance-migration');
  const query = vi.fn().mockRejectedValue(new Error('unexpected database access'));
  const fileSql = changedPart === 'embedded' ? original : changed;
  const alteredFile = { ...PRESCRIPTION_ISSUANCE_MIGRATIONS[0], sql: fileSql, checksum: checksumOf(fileSql) };

  await expect(validatePrescriptionIssuanceMigration({ query } as never, [alteredFile], []))
    .rejects.toThrow('PRESCRIPTION_ISSUANCE_SOURCE_MISMATCH: 0093');
  expect(query).not.toHaveBeenCalled();
});

it('accepts the unchanged historical 0093 source for an empty catalogue', async () => {
  const { PRESCRIPTION_ISSUANCE_MIGRATIONS, validatePrescriptionIssuanceMigration } = await import('../lib/prescription-issuance-migration');
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await expect(validatePrescriptionIssuanceMigration({ query } as never, PRESCRIPTION_ISSUANCE_MIGRATIONS, []))
    .resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(2);
});
