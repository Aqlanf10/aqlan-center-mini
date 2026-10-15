import { expect, it } from 'vitest';
import { createHrHistoryDraftStore } from '../lib/hr-history-drafts';
import { parseHrHistoryCommand } from '../lib/hr-temporal-request';
const command = () => parseHrHistoryCommand({ requestId: 'synthetic-draft-0001', expectedUsername: 'a', expectedRevision: 0, reason: 'Documented synthetic instruction', supersedeIds: [], append: [{ id: 'fact-one', kind: 'known', from: '2026-10-01', to: null, value: { status: 'active' } }] }, 'employment', 7);
it('retains immutable exact intent across close/reopen and prevents a detached reply settling it', () => {
  const store = createHrHistoryDraftStore(); store.enter('a', 'staff', true);
  const old = store.capture('a'), input = command(), controller = new AbortController(); old.track(controller);
  expect(store.reserve('a', 'employment:7', old, input)).toBe(true);
  expect(store.reserve('a', 'employment:7', old, input)).toBe(false);
  old.detach(); expect(controller.signal.aborted).toBe(true);
  expect(store.settle('a', 'employment:7', old, input)).toBe(false);
  const fresh = store.capture('a'); expect(store.get('a', 'employment:7')).toEqual(input);
  expect(Object.isFrozen(store.get('a', 'employment:7')?.append[0].value)).toBe(true);
  expect(store.settle('a', 'employment:7', fresh, { ...input, reason: 'Changed' })).toBe(false);
  expect(store.settle('a', 'employment:7', fresh, input)).toBe(true); expect(store.hasPending()).toBe(false);
});
it('fences A→B→A generations, revoked admin, foreign owner and fabricated leases', () => {
  const store = createHrHistoryDraftStore(), input = command(); const cleanup = store.enter('a', 'staff', true), old = store.capture('a');
  store.reserve('a', 'employment:7', old, input); store.enter('b', 'staff', true);
  expect(store.get('b', 'employment:7')).toBeUndefined(); expect(store.settle('a', 'employment:7', store.capture('b'), input)).toBe(false);
  store.enter('a', 'staff', true); cleanup(); expect(old.current()).toBe(false);
  expect(store.settle('a', 'employment:7', old, input)).toBe(false);
  expect(store.settle('a', 'employment:7', { owner: 'a', current: () => true, detach() {}, track() {} }, input)).toBe(false);
  const current = store.capture('a'); expect(current.current()).toBe(true);
  store.enter('a', 'staff', false); expect(current.current()).toBe(false); expect(store.capture('a').current()).toBe(false);
});
