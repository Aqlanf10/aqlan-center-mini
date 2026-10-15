import { expect, it } from 'vitest';
import { canonicalHrIntent, matchingHrHistoryReceipt, parseHrHistoryCommand } from '../lib/hr-temporal-request';

const body = () => ({ requestId: 'employment-request-0001', expectedUsername: 'manager', expectedRevision: 0, reason: 'Documented start', supersedeIds: [], append: [
  { id: 'documented-start', kind: 'known', from: '2026-10-01', to: null, value: { status: 'active' } },
] });
it('pins the subject, operation, dates, expected revision and reason in immutable canonical intent', () => {
  const input = body(), command = parseHrHistoryCommand(input, 'employment', 7);
  input.append[0].value.status = 'ended';
  expect(command.append[0].value).toEqual({ status: 'active' }); expect(Object.isFrozen(command.append[0])).toBe(true);
  expect(canonicalHrIntent(command)).toBe(canonicalHrIntent({ ...command, append: command.append.map(f => Object.fromEntries(Object.entries(f).reverse())) }));
  for (const other of [{ ...command, staffId: 8 }, { ...command, expectedRevision: 1 }, { ...command, reason: 'Different reason' }, { ...command, supersedeIds: ['retired'] }]) expect(canonicalHrIntent(other)).not.toBe(canonicalHrIntent(command));
});
it.each(['actorUserId', 'actor', 'authority', 'authorize', 'approved', 'staffId', 'operation'])('refuses forged server field %s', field => {
  expect(() => parseHrHistoryCommand({ ...body(), [field]: 1 }, 'employment', 7)).toThrow(/الجلسة/);
});
it('requires real explicit end-exclusive dates and fresh intent identity', () => {
  expect(() => parseHrHistoryCommand({ ...body(), requestId: 'short' }, 'employment', 7)).toThrow();
  expect(() => parseHrHistoryCommand({ ...body(), append: [{ ...body().append[0], from: '2026-02-30' }] }, 'employment', 7)).toThrow();
  expect(() => parseHrHistoryCommand({ ...body(), append: [{ ...body().append[0], to: '2026-10-01' }] }, 'employment', 7)).toThrow();
  expect(() => parseHrHistoryCommand({ ...body(), append: [{ kind: 'unknown', id: 'legacy', value: { status: 'active' } }] }, 'employment', 7)).toThrow(/صريحة/);
});
it('does not accept a foreign or mismatched receipt after an uncertain response', () => {
  const command = parseHrHistoryCommand(body(), 'employment', 7);
  const receipt = { requestId: command.requestId, intent: command, intentDigest: 'a'.repeat(64), staffId: 7, operation: command.operation, actorUserId: 1, actorUsername: 'manager', recordedAt: '2026-10-11 12:00:00.123456+00', revision: 1, activation: 'documented_only', timeline: { revision: 1, facts: command.append } };
  expect(matchingHrHistoryReceipt(receipt, command, 'manager')).toBe(true);
  for (const changed of [{ ...receipt, staffId: 8 }, { ...receipt, actorUsername: 'other' }, { ...receipt, revision: 2 }, { ...receipt, intent: { ...command, reason: 'changed' } }, { ...receipt, actorUserId: null }, { ...receipt, recordedAt: 'invalid' }, { ...receipt, timeline: { revision: 1, facts: [] } }]) expect(matchingHrHistoryReceipt(changed, command, 'manager')).toBe(false);
});
