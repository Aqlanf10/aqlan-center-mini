import { expect, it } from 'vitest';
import { canonicalPrescriptionCommand } from '../lib/prescription-command';
import { getOrCreatePrescriptionCommand, readPrescriptionCommand, prescriptionCommandStorageKey } from '../lib/prescription-command-client';
const key = '11111111-1111-4111-8111-111111111111';
const scope = prescriptionCommandStorageKey('synthetic', 7, 9);
const storage = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; };
it('retains the same durable opaque key across double clicks, lost response and refresh', () => {
 const store = storage(); const first = getOrCreatePrescriptionCommand(store, scope, 'a'.repeat(64), 5, () => key);
 expect(getOrCreatePrescriptionCommand(store, scope, 'a'.repeat(64), 5, () => { throw new Error('Must not rotate'); })).toEqual(first);
 expect(readPrescriptionCommand(store, scope)).toEqual(first);
 expect(Object.keys(JSON.parse(store.getItem(scope)!)).sort()).toEqual(['digest', 'key', 'prescribingDoctorPartyId', 'version']);
});
it('refuses payload or prescriber changes without an explicit new-issuance decision', () => {
 const store = storage(); getOrCreatePrescriptionCommand(store, scope, 'a'.repeat(64), 5, () => key);
 expect(() => getOrCreatePrescriptionCommand(store, scope, 'b'.repeat(64), 5, () => key)).toThrow();
 expect(() => getOrCreatePrescriptionCommand(store, scope, 'a'.repeat(64), 6, () => key)).toThrow();
 expect(readPrescriptionCommand(store, scope)?.key).toBe(key);
});
it('fails closed on malformed or unavailable durable tab storage', () => {
 const store = storage(); store.setItem(scope, 'corrupt'); expect(() => readPrescriptionCommand(store, scope)).toThrow();
 expect(() => getOrCreatePrescriptionCommand({ ...store, getItem: () => null, setItem: () => { throw new Error('Storage denied'); } }, scope, 'a'.repeat(64), 5, () => key)).toThrow('Storage denied');
});
it('canonical command excludes mutable doctor label/proof but binds exact clinical semantic fields', () => {
 const draft = { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5, prescribingDoctorName: 'Old', diagnosis: 'Synthetic', notes: '', instructionsLang: 'both' as const, items: [{ name: 'SyntheticRx', dose: '500mg', form: 'tablet', frequency: 'fixture', duration: 'fixture', instructions: 'محفوظ', instructionsEn: 'saved', selection: { id: 'manual' as const, amount: '1 tablet', confirmed: true } }] };
 expect(canonicalPrescriptionCommand({ ...draft, prescribingDoctorName: 'Changed' })).toBe(canonicalPrescriptionCommand(draft));
 for (const changed of [{ ...draft, patientId: 8 }, { ...draft, visitId: 10 }, { ...draft, prescribingDoctorPartyId: 6 }, { ...draft, items: [{ ...draft.items[0], selection: { ...draft.items[0].selection, amount: '2 tablets' } }] }]) expect(canonicalPrescriptionCommand(changed)).not.toBe(canonicalPrescriptionCommand(draft));
});

import { createPrescriptionOperationFence } from '../lib/prescription-command-client';
it('synchronously rejects double clicks and retires deferred work on close, principal or patient changes', () => {
 const fence = createPrescriptionOperationFence(); fence.setScope('patient7:actorA'); const first = fence.start()!;
 expect(fence.start()).toBeNull(); expect(fence.isBusy()).toBe(true);
 fence.retire(); fence.setScope('patient8:actorB'); const next = fence.start()!;
 expect(fence.current(first)).toBe(false); fence.finish(first); expect(fence.isBusy()).toBe(true);
 expect(fence.current(next)).toBe(true); fence.finish(next); expect(fence.isBusy()).toBe(false);
});
it('does not revive a pending operation when closing and reopening the same scope', () => {
 const fence = createPrescriptionOperationFence(); fence.setScope('same'); const previous = fence.start()!;
 fence.retire(); fence.setScope('same'); expect(fence.current(previous)).toBe(false); expect(fence.start()).not.toBeNull();
});
