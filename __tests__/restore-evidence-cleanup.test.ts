import { expect, it, vi } from 'vitest';
import { closeRestoreEvidence, closeRestoreEvidenceAfter } from './helpers/restore-evidence-cleanup';

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

it('closes a retained fixture after application-pool cleanup fails and preserves the original error', async () => {
  const original = new Error('synthetic-pool-close-failure');
  const beforeClose = vi.fn(async () => { throw original; });
  const close = vi.fn(async () => {});
  const remove = vi.fn();
  await expect(closeRestoreEvidenceAfter(beforeClose, { close, directory: '/synthetic/evidence', retain: true, remove })).rejects.toBe(original);
  expect(beforeClose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it('preserves both errors if application-pool and retained fixture cleanup fail', async () => {
  const original = new Error('synthetic-pool-close-failure');
  const fixtureFailure = new Error('synthetic-fixture-close-failure');
  const remove = vi.fn();
  let received: unknown;
  try {
    await closeRestoreEvidenceAfter(async () => { throw original; }, {
      close: async () => { throw fixtureFailure; }, directory: '/synthetic/evidence', retain: true, remove,
    });
  } catch (error) { received = error; }
  expect(received).toBeInstanceOf(AggregateError);
  expect((received as AggregateError).errors).toEqual([original, fixtureFailure]);
  expect(remove).not.toHaveBeenCalled();
});
