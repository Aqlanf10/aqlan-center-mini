import { canonicalHrIntent, type HrHistoryCommand } from './hr-temporal-request';
import { immutableJson } from './hr-temporal';

export interface HrHistoryLease { readonly owner: string; current(): boolean; detach(): void; track(controller: AbortController): void }
/** Page-owned memory only. Owner/tab generations fence A→B→A and modal reopen callbacks. */
export function createHrHistoryDraftStore() {
  let active: { owner: string; view: string; admin: boolean } | undefined, version = 0;
  const pending = new Map<string, HrHistoryCommand>(), listeners = new Set<() => void>(), leases = new Set<HrHistoryLease>();
  const key = (owner: string, scope: string) => `${owner}\u0000${scope}`;
  const publish = () => { version++; for (const listener of listeners) listener(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version,
    enter(owner: string, view: string, admin: boolean) {
      for (const lease of [...leases]) lease.detach();
      const generation = { owner, view, admin }; active = generation;
      return () => { if (active === generation) { active = undefined; for (const lease of [...leases]) lease.detach(); } };
    },
    capture(owner: string): HrHistoryLease {
      const generation = active, controllers = new Set<AbortController>(); let mounted = true;
      const lease: HrHistoryLease = {
        owner,
        current: () => mounted && generation !== undefined && active === generation && generation.owner === owner && generation.admin,
        track(controller) { if (!lease.current()) controller.abort(); else controllers.add(controller); },
        detach() { mounted = false; leases.delete(lease); for (const controller of controllers) controller.abort(); controllers.clear(); },
      };
      leases.add(lease); return lease;
    },
    get(owner: string, scope: string) { return pending.get(key(owner, scope)); },
    reserve(owner: string, scope: string, lease: HrHistoryLease, command: HrHistoryCommand): boolean {
      if (!leases.has(lease) || lease.owner !== owner || !lease.current() || pending.has(key(owner, scope))) return false;
      pending.set(key(owner, scope), immutableJson(command)); publish(); return true;
    },
    settle(owner: string, scope: string, lease: HrHistoryLease, command: HrHistoryCommand): boolean {
      const saved = pending.get(key(owner, scope));
      if (!leases.has(lease) || lease.owner !== owner || !lease.current() || !saved || canonicalHrIntent(saved) !== canonicalHrIntent(command)) return false;
      pending.delete(key(owner, scope)); publish(); return true;
    },
    hasPending: () => pending.size > 0,
  };
}
