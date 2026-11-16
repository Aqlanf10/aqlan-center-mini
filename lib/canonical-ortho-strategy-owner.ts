import type { StrategyLifetime, StrategyWriteLease } from "@/components/OrthoTreatmentStrategy";
import { makeDraft, beginMutation, beginRetryMutation, currentMutation, endMutation, type MutationOwner } from "./ortho-draft-lifetime";

/** Adapter to the native draft/receipt lifetime. No persistent clinical storage or
 * automatic replay. Parent refresh revokes response ownership, not frozen bytes. */
export function makeCanonicalStrategyOwner(admission: { authorized: () => boolean; deny: () => void }) {
  const state: MutationOwner = { active: true, denied: false, clinical: true, mutationSequence: 0, denialSequence: 0, mutations: new Set() };
  const draft = makeDraft(); let generation = 0;
  const active = () => state.active && !state.denied && admission.authorized();
  const notify = (refresh = false) => draft.strategyView.notify(refresh);
  function begin(retry: boolean): StrategyWriteLease | null {
    const operation = retry ? beginRetryMutation(state, draft, active()) : beginMutation(state, draft, active());
    if (!operation) return null;
    const epoch = generation;
    const current = () => active() && epoch === generation && currentMutation(state, operation);
    notify();
    return { current,
      checkHeaders: response => {
        if (!current()) return false;
        if ([401, 403].includes(response.status)) { state.denied = true; admission.deny(); return false; }
        return true;
      },
      markUncertain: () => { if (state.active) { draft.markUncertain(); notify(); } },
      finish: () => {
        if (!current() && state.active) draft.markUncertain();
        endMutation(state, operation); notify();
      },
    };
  }
  const lifetime: StrategyLifetime = {
    identity: draft, active, editable: () => active() && !draft.busy && !draft.uncertain,
    denied: () => { state.denied = true; admission.deny(); },
    get busy() { return draft.busy; }, get uncertain() { return draft.uncertain; }, get dirty() { return draft.dirty; },
    get readVersion() { return draft.strategyView.readVersion; }, refresh: () => { if (active()) notify(true); },
    get values() { return { document: String(draft.values.get("document") ?? ""), problemLabel: "", problemSite: "" }; },
    change: (field, value) => {
      if (!active() || draft.busy || draft.uncertain || field !== "document") return;
      const previous = draft.values.get(field) ?? ""; draft.trackEdit(field, previous, value); draft.values.set(field, value); notify();
    },
    settle: (field, value) => { if (active() && !draft.busy && !draft.uncertain && field === "document") { draft.settleField(field, value); notify(); } },
    begin: () => begin(false), beginRetry: () => begin(true),
  };
  return {
    lifetime,
    subscribe: draft.strategyView.subscribe,
    invalidateRead: () => { generation++; if (draft.busy) draft.markUncertain(); notify(); },
    canLeave: (confirm: () => boolean) => !state.active || !draft.busy && !draft.uncertain && (!draft.dirty || confirm()),
    needsUnloadWarning: () => state.active && (draft.busy || draft.uncertain || draft.dirty),
    retire: () => {
      state.active = false; state.clinical = false; state.denialSequence++; generation++;
      for (const operation of state.mutations) operation.active = false;
      draft.active = false; draft.values.clear(); draft.edits.clear(); draft.dirty = false;
      notify(); draft.strategyView.clear();
    },
  };
}
export type CanonicalStrategyOwner = ReturnType<typeof makeCanonicalStrategyOwner>;
