/** Fixed, bounded diagnostics only: never print response bodies, URLs, identities or error text. */
import { appendFileSync } from 'node:fs';
type Emit = (message: string) => void;
export function persistDiagnostic(filename: string | undefined, message: string, append = appendFileSync): void {
  if (!filename) return;
  try { append(filename, `${message}\n`, { encoding: 'utf8', mode: 0o600 }); }
  catch { /* Diagnostics must never change the original test result. */ }
}
const emitNotice: Emit = message => {
  // GitHub may not recognize workflow commands embedded in Vitest's reporter
  // output. A separate CI step validates and emits these bounded lines.
  persistDiagnostic(process.env.FINANCE_CI_DIAGNOSTICS_PATH, message);
  console.log(message);
};
const safelyEmit = (emit: Emit, message: string): void => { try { emit(message); } catch { /* Preserve the test result. */ } };
const statuses = new Set([200, 201, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]);
const count = (value: unknown): string => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10 ? String(value) : 'other';
const status = (value: unknown): string => typeof value === 'number' && statuses.has(value) ? String(value) : 'other';

/** Preserve the original poll and rethrow its original failure after reporting bounded counts. */
export async function diagnoseCount(
  read: () => Promise<number>, expected: number,
  verify: (read: () => Promise<number>) => Promise<void>, emit: Emit = emitNotice,
): Promise<void> {
  let actual: unknown = null;
  try { await verify(async () => { actual = await read(); return actual as number; }); }
  catch (error) { safelyEmit(emit, `::notice::FINANCE_CI_DIAG COUNT actual=${count(actual)} expected=${count(expected)}`); throw error; }
}

/** The caller keeps its original status assertion. */
export function diagnoseRetryStatus(actual: unknown, emit: Emit = emitNotice): void {
  if (actual !== 409) safelyEmit(emit, `::notice::FINANCE_CI_DIAG RETRY status=${status(actual)}`);
}

/** Preserve the original reload failure; inspect only its class, never its message. */
export async function diagnoseReload<T>(reload: () => Promise<T>, emit: Emit = emitNotice): Promise<T> {
  try { return await reload(); }
  catch (error) {
    let kind = 'other';
    try { if (error instanceof Error && error.name === 'TimeoutError') kind = 'timeout'; } catch { /* Keep the original failure. */ }
    safelyEmit(emit, `::notice::FINANCE_CI_DIAG RELOAD kind=${kind}`);
    throw error;
  }
}
