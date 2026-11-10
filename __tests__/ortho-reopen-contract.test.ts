import { describe, expect, it } from 'vitest';
import { readOrthoReopenCommand } from '../lib/ortho-reopen-contract';
const command = { schemaVersion: 1, clientRequestId: 'synthetic-reopen-0001', expectedLifecycleVersion: 0,
  expectedStatus: 'completed', targetStatus: 'retention', reason: 'Synthetic clinician-directed follow-up' };
describe('explicit clinical reopening command', () => {
  it.each(['assessment', 'active', 'retention'])('accepts explicit %s intent without inference', targetStatus => {
    expect(readOrthoReopenCommand({ ...command, targetStatus })).toEqual({ ...command, targetStatus });
  });
  it.each([{ targetStatus: 'planned' }, { targetStatus: 'completed' }, { expectedStatus: 'active' },
    { reason: '' }, { reason: ' ' }, { reason: 'x'.repeat(501) }, { reason: '\u0000' },
    { expectedLifecycleVersion: -1 }, { expectedLifecycleVersion: 0.5 }, { expectedLifecycleVersion: 2147483647 },
    { clientRequestId: 'short' }, { phase: 'aligning' }, { planId: 7 }, { invoice: {} }])('rejects ambiguous/forged input %j', change => {
    expect(() => readOrthoReopenCommand({ ...command, ...change })).toThrow('invalid_reopen_command');
  });
  it('requires every field and preserves the exact reason for durable fingerprinting', () => {
    const { targetStatus: _target, ...missing } = command;
    expect(() => readOrthoReopenCommand(missing)).toThrow();
    expect(readOrthoReopenCommand({ ...command, reason: ' Exact reason ' }).reason).toBe(' Exact reason ');
  });
});
