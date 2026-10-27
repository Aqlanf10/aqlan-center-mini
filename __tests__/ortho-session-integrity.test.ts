import { describe, expect, it } from 'vitest';
import { checkOrthoSessionDraft, resolveOrthoWire } from '../lib/ortho-baseline';

const draft = { caseId: 3, done: 'Reviewed; no change documented', nextWeeks: 4 };
describe('orthodontic session input fidelity', () => {
  it.each([undefined, null, '', '   '])('rejects undocumented new work: %s', done => {
    expect(checkOrthoSessionDraft({ ...draft, done }).ok).toBe(false);
  });
  it('allows explicit documented no-change review without inventing wires', () => {
    expect(checkOrthoSessionDraft(draft)).toMatchObject({ ok: true, value: { done: draft.done, upperWire: null, lowerWire: null } });
  });
  it.each([0, -1, 53, 1.5, 'abc', '', null, true, false, [], [4], {}].map(value => [value]))('rejects invalid explicit interval %s', nextWeeks => {
    expect(checkOrthoSessionDraft({ ...draft, nextWeeks }).ok).toBe(false);
  });
  it('retains default for omitted legacy interval only', () => {
    expect(checkOrthoSessionDraft({ caseId: 3, done: draft.done })).toMatchObject({ ok: true, value: { nextWeeks: 4 } });
  });
  it('carries an explicit removal independently from blank legacy wire fields', () => {
    expect(checkOrthoSessionDraft({ ...draft, upperWireAction: 'remove' })).toMatchObject({ ok: true, value: { upperWire: null, upperWireAction: 'remove' } });
  });
  it.each([{ upperWireAction: 'remove', upperWire: '016' }, { lowerWireAction: 'guess' }])('rejects ambiguous wire instruction %j', change => {
    expect(checkOrthoSessionDraft({ ...draft, ...change }).ok).toBe(false);
  });
});


describe('wire resolution compatibility', () => {
  it('retains legacy null and blank wires', () => {
    expect(resolveOrthoWire('old', null)).toBe('old');
    expect(resolveOrthoWire('old', '  ')).toBe('old');
  });
  it('supports explicit removal and explicit replacement', () => {
    expect(resolveOrthoWire('old', null, 'remove')).toBeNull();
    expect(resolveOrthoWire('old', ' new ')).toBe('new');
  });
});
