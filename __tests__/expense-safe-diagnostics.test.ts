import { describe, expect, it } from 'vitest';
import { diagnoseCount, diagnoseReload, diagnoseRetryStatus } from './security-http/_expense-safe-diagnostics';

const secret = 'PRIVATE_SYNTHETIC::error file=leak\nhttps://example.invalid/secret';

describe('bounded expense CI diagnostics', () => {
  it('preserves successful repeated reads without emitting a notice', async () => {
    const output: string[] = [], values = [0, 1];
    await diagnoseCount(async () => values.shift()!, 1, async read => {
      expect(await read()).toBe(0); expect(await read()).toBe(1);
    }, m => output.push(m));
    expect(output).toEqual([]);
  });
  it('emits only bounded counts on a failed poll and rethrows the same failure', async () => {
    const output: string[] = [], failure = new Error(secret);
    const verify = async (read: () => Promise<number>) => { await read(); throw failure; };
    await expect(diagnoseCount(async () => 2, 1, verify, m => output.push(m))).rejects.toBe(failure);
    expect(output).toEqual(['::notice::FINANCE_CI_DIAG COUNT actual=2 expected=1']);
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it('never prints unbounded, nonnumeric or missing counts, even when reading fails', async () => {
    const output: string[] = [], failure = new Error(secret);
    for (const value of [-1, 11, Infinity, NaN, secret]) {
      await expect(diagnoseCount(async () => value as number, 999, async read => { await read(); throw failure; }, m => output.push(m))).rejects.toBe(failure);
    }
    await expect(diagnoseCount(async () => { throw failure; }, 0, async read => { await read(); }, m => output.push(m))).rejects.toBe(failure);
    expect(output).toEqual([...Array(5).fill('::notice::FINANCE_CI_DIAG COUNT actual=other expected=other'),
      '::notice::FINANCE_CI_DIAG COUNT actual=other expected=0']);
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it('allows only fixed HTTP status codes and stays silent for the expected 409', () => {
    const output: string[] = [];
    for (const value of [409, 201, 401, 503, 299, secret, null]) diagnoseRetryStatus(value, m => output.push(m));
    expect(output).toEqual(['::notice::FINANCE_CI_DIAG RETRY status=201', '::notice::FINANCE_CI_DIAG RETRY status=401',
      '::notice::FINANCE_CI_DIAG RETRY status=503', '::notice::FINANCE_CI_DIAG RETRY status=other',
      '::notice::FINANCE_CI_DIAG RETRY status=other', '::notice::FINANCE_CI_DIAG RETRY status=other']);
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it('classifies timeout versus other errors and preserves the exact error and successful return', async () => {
    const output: string[] = [], timeout = new Error(secret), other = new Error(secret);
    timeout.name = 'TimeoutError';
    await expect(diagnoseReload(async () => { throw timeout; }, m => output.push(m))).rejects.toBe(timeout);
    await expect(diagnoseReload(async () => { throw other; }, m => output.push(m))).rejects.toBe(other);
    expect(await diagnoseReload(async () => 42, m => output.push(m))).toBe(42);
    expect(output).toEqual(['::notice::FINANCE_CI_DIAG RELOAD kind=timeout', '::notice::FINANCE_CI_DIAG RELOAD kind=other']);
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it('cannot replace the original failure when diagnostic output fails', async () => {
    const original = new Error(secret), broken = () => { throw new Error('synthetic output failure'); };
    await expect(diagnoseCount(async () => 2, 1, async read => { await read(); throw original; }, broken)).rejects.toBe(original);
    await expect(diagnoseReload(async () => { throw original; }, broken)).rejects.toBe(original);
    expect(() => diagnoseRetryStatus(500, broken)).not.toThrow();
  });
});
