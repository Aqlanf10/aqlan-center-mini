import { expect, it } from 'vitest';
import { prepareBackupSql } from '../lib/restore/sql.mjs';
import { SYNTHETIC_DUPLICATE_PATIENT_SQL } from './helpers/restore-late-constraint';
import { nextSequenceCandidate } from './helpers/restore-sequence-observation';

const catalog = [{ version: '0001', name: 'baseline', checksum: '0'.repeat(64) }];

it('accepts the late constraint witness as writer SQL, but rejects executable expressions', () => {
  const wrapped = (statement: string) => `BEGIN;\n${statement}\nCOMMIT;`;
  const prepared = prepareBackupSql(wrapped(SYNTHETIC_DUPLICATE_PATIENT_SQL), { migrationFiles: catalog });
  expect(prepared.dataSql).toContain(SYNTHETIC_DUPLICATE_PATIENT_SQL);
  expect(prepared.sqlRowsStatementLines).toBe(1);
  expect(() => prepareBackupSql(wrapped('SELECT 1 / 0;'), { migrationFiles: catalog }))
    .toThrow('Unsupported restore writer statement.');
});

it('compares sequence candidates without number precision loss or reusing an already-called value', () => {
  expect(nextSequenceCandidate('99999', true) === 100000n).toBe(true);
  expect(nextSequenceCandidate('9007199254740993', false) === 9007199254740993n).toBe(true);
  expect(nextSequenceCandidate('9007199254740993', true) === 9007199254740994n).toBe(true);
});
