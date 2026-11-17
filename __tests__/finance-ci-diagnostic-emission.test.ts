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
});
