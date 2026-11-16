/** Existing orthodontic draft/mutation transitions shared by legacy and canonical adapters. */
export type Draft = { values: Map<string, unknown>; edits: Map<string, unknown>; urls: Set<string>; active: boolean; busy: boolean; uncertain: boolean; dirty: boolean;
  strategyView: { readonly readVersion: number; subscribe(listener: () => void): () => void; notify(refresh?: boolean): void; clear(): void };
  settleField(name: string, value: unknown): void;
  activate: () => void; markUncertain: () => void; trackEdit: (name: string, previous: unknown, next: unknown) => void;
};
export type Mutation = { draft: Draft; sequence: number; denial: number; active: boolean };
export interface MutationOwner { active: boolean; denied: boolean; clinical: boolean; mutationSequence: number; denialSequence: number; mutations: Set<Mutation> }
function sameDraftValue(before: unknown, after: unknown) {
  return Object.is(before, after) || (Array.isArray(before) && Array.isArray(after)
    && before.length === after.length && before.every((value, index) => Object.is(value, after[index])));
}
export function makeDraft(): Draft {
  const strategyListeners = new Set<() => void>();
  let strategyReadVersion = 0;
  const draft: Draft = { values: new Map(), edits: new Map(), urls: new Set(), active: true, busy: false, uncertain: false, dirty: false,
    strategyView: {
      get readVersion() { return strategyReadVersion; },
      subscribe: (listener) => { strategyListeners.add(listener); return () => { strategyListeners.delete(listener); }; },
      notify: (refresh = false) => {
        if (refresh) strategyReadVersion++;
        for (const listener of [...strategyListeners]) listener();
      },
      clear: () => { strategyListeners.clear(); },
    },
    settleField: (name, value) => {
      draft.values.set(name, value); draft.edits.delete(name); draft.dirty = draft.edits.size > 0;
    },
    activate: () => { draft.active = true; },
    markUncertain: () => { draft.uncertain = true; },
    trackEdit: (name, previous, next) => {
      // Opening/closing the booking form changes presentation, not its data.
      if (name === "booking") return;
      const baseline = draft.edits.has(name) ? draft.edits.get(name) : previous;
      if (sameDraftValue(baseline, next)) draft.edits.delete(name);
      else draft.edits.set(name, baseline);
      draft.dirty = draft.edits.size > 0;
    },
  };
  return draft;
}
export function currentMutation(owner: MutationOwner, operation: Mutation | null): operation is Mutation {
  return !!operation && owner.active && !owner.denied && operation.active && operation.draft.active
    && operation.denial === owner.denialSequence;
}
export function beginMutation(owner: MutationOwner, draft: Draft, allowed: boolean): Mutation | null {
  if (!owner.active || owner.denied || !owner.clinical || !draft.active || draft.busy || draft.uncertain || !allowed) return null;
  draft.busy = true;
  const operation = { draft, sequence: ++owner.mutationSequence, denial: owner.denialSequence, active: true };
  owner.mutations.add(operation); return operation;
}
export function endMutation(owner: MutationOwner, operation: Mutation) {
  operation.active = false; operation.draft.busy = false; owner.mutations.delete(operation);
}
export function beginRetryMutation(owner: MutationOwner, draft: Draft, allowed: boolean): Mutation | null {
  if (!allowed || !draft.active || !draft.uncertain || draft.busy) return null;
  // Reconcile only the frozen command; a failed admission keeps it uncertain.
  draft.uncertain = false;
  const operation = beginMutation(owner, draft, true);
  if (!operation) draft.uncertain = true;
  return operation;
}
