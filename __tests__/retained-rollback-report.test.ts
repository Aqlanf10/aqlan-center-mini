import { expect, it } from 'vitest';
import { initialRetainedRollbackReport, serializeRetainedRollbackReport, syntheticSequenceState } from './helpers/retained-rollback-report';
import { selectSyntheticWitnessDirectory } from './helpers/capture-focused-rollback-report';
import { spawnSync } from 'node:child_process';

it('accepts a complete fixed synthetic report and exposes only its fixed fields', () => {
  const report = { ...initialRetainedRollbackReport(), databases: 3, identityBefore: true, identityAfter: true,
    legacySha256: 'a'.repeat(64), faultySha256: 'b'.repeat(64), outcome: 'duplicate_constraint' as const,
    rows: 'unchanged' as const, registry: 'unchanged' as const, patientIdSequence: 'regressed' as const,
    patientNumberSequence: 'unchanged' as const };
  expect(JSON.parse(serializeRetainedRollbackReport(report, true))).toEqual(report);
});

it('rejects incomplete reports, extra fields, free text and malformed digests', () => {
  const report = initialRetainedRollbackReport();
  expect(() => serializeRetainedRollbackReport(report, true)).toThrow();
  expect(() => serializeRetainedRollbackReport({ ...report, path: '/synthetic/private' })).toThrow();
  expect(() => serializeRetainedRollbackReport({ ...report, outcome: 'synthetic-private-marker' })).toThrow();
  expect(() => serializeRetainedRollbackReport({ ...report, legacySha256: 'synthetic-private-marker' })).toThrow();
  expect(() => serializeRetainedRollbackReport({ ...report, databases: 4 })).toThrow();
});

it('classifies sequence movements without exposing their values', () => {
  expect(syntheticSequenceState(100n, 99n)).toBe('regressed');
  expect(syntheticSequenceState(100n, 100n)).toBe('unchanged');
  expect(syntheticSequenceState(100n, 101n)).toBe('advanced');
});

it('selects exactly one directory belonging to this numeric run and attempt', () => {
  const name = 'hr-composed-legacy-restore-12345-2-Ab12Cd';
  expect(selectSyntheticWitnessDirectory([name, 'hr-composed-legacy-restore-12345-1-Zz22Yy'], '12345', '2')).toBe(name);
  expect(() => selectSyntheticWitnessDirectory([], '12345', '2')).toThrow();
  expect(() => selectSyntheticWitnessDirectory([name, 'hr-composed-legacy-restore-12345-2-Ef34Gh'], '12345', '2')).toThrow();
  expect(() => selectSyntheticWitnessDirectory([name], '../12345', '2')).toThrow();
  expect(() => selectSyntheticWitnessDirectory(['hr-composed-legacy-restore-12345-2-../bad'], '12345', '2')).toThrow();
});

it('refuses unsafe CLI capture with only a fixed diagnostic and no input data', () => {
  const marker = 'synthetic-private-marker';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '__tests__/helpers/capture-focused-rollback-report-cli.mts'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', RAILWAY_PROJECT_ID: marker },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('SYNTHETIC_REPORT_CAPTURE_FAILED\n');
  expect(result.stdout).toBe('');
  expect((result.stdout + result.stderr).includes(marker)).toBe(false);
});
