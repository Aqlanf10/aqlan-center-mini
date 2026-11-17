import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatedNotices } from '../scripts/emit-finance-ci-diagnostics.mjs';

describe('bounded finance CI diagnostic emission', () => {
  it('accepts only complete bounded notices and preserves their order', () => {
    const lines = [
      '::notice::FINANCE_CI_DIAG COUNT actual=2 expected=1',
      '::notice::FINANCE_CI_DIAG RETRY status=503',
      '::notice::FINANCE_CI_DIAG RELOAD kind=timeout',
      '::notice::FINANCE_CI_DIAG COUNT actual=other expected=10',
    ];
    expect(validatedNotices(`${lines.join('\n')}\n`)).toEqual(lines);
    expect(validatedNotices('')).toEqual([]);
  });

  it('rejects the whole input when it contains an unbounded or injected line', () => {
    const valid = '::notice::FINANCE_CI_DIAG RETRY status=503\n';
    for (const unsafe of [
      'PRIVATE_SYNTHETIC\n',
      '::notice::FINANCE_CI_DIAG COUNT actual=11 expected=1\n',
      '::notice::FINANCE_CI_DIAG RETRY status=299\n',
      '::notice::FINANCE_CI_DIAG RELOAD kind=secret\n',
      '::error::PRIVATE_SYNTHETIC\n',
      valid.trimEnd(),
      valid.repeat(101),
      'x'.repeat(16385),
    ]) expect(validatedNotices(valid + unsafe)).toBeNull();
  });

  it('uses the same run, attempt and shard specific file for writing and reporting', () => {
    const workflow = readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const writer = /FINANCE_CI_DIAGNOSTICS_PATH: ([^\n]+)/.exec(workflow)?.[1];
    const reader = /node scripts\/emit-finance-ci-diagnostics\.mjs "([^\n"]+)"/.exec(workflow)?.[1];
    const template = '${{ runner.temp }}/finance-ci-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}.txt';
    expect(writer).toBe(template);
    expect(reader).toBe(template);
    const resolve = (run: number, attempt: number, shard: number) => template
      .replace('${{ runner.temp }}', '/synthetic/runner-temp')
      .replace('${{ github.run_id }}', String(run))
      .replace('${{ github.run_attempt }}', String(attempt))
      .replace('${{ matrix.shard }}', String(shard));
    expect(new Set([resolve(1, 1, 1), resolve(2, 1, 1), resolve(1, 2, 1), resolve(1, 1, 2)]).size).toBe(4);
  });
});
