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
