import { expect, it, vi } from 'vitest';
import { closeRestoreEvidence } from './helpers/restore-evidence-cleanup';

it('closes retained fixtures without removing their evidence, even on close failure', async () => {
  const remove = vi.fn();
  const close = vi.fn(async () => { throw new Error('synthetic-close-failure'); });
  await expect(closeRestoreEvidence({ close, directory: '/synthetic/evidence', retain: true, remove })).rejects.toThrow('synthetic-close-failure');
  expect(close).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it('keeps the original cleanup behavior outside retain-only mode', async () => {
  const remove = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  await closeRestoreEvidence({ close, directory: '/synthetic/evidence', retain: false, remove });
  expect(close).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('/synthetic/evidence', { recursive: true, force: true });
});
