import { rm } from 'node:fs/promises';

/** Retention is selected only by the dedicated guarded synthetic CI witness. */
export async function closeRestoreEvidence(options: {
  close?: () => Promise<void>;
  directory?: string;
  retain: boolean;
  remove?: typeof rm;
}): Promise<void> {
  try { await options.close?.(); }
  finally {
    if (options.directory && !options.retain) {
      await (options.remove ?? rm)(options.directory, { recursive: true, force: true });
    }
  }
}

/** Close the fixture even if a preceding application-pool cleanup fails. */
export async function closeRestoreEvidenceAfter(
  beforeClose: () => Promise<void>,
  options: Parameters<typeof closeRestoreEvidence>[0],
): Promise<void> {
  let priorFailed = false;
  let priorError: unknown;
  try { await beforeClose(); } catch (error) { priorFailed = true; priorError = error; }
  try { await closeRestoreEvidence(options); }
  catch (error) {
    if (priorFailed) throw new AggregateError([priorError, error], 'Restore evidence cleanup failed');
    throw error;
  }
  if (priorFailed) throw priorError;
}
