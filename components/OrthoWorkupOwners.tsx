"use client";

import { createContext, useContext, useLayoutEffect, useRef } from "react";

export type OrthoWorkupOwnerState = { active: boolean; busy: boolean; dirty: boolean };
type OwnerStateReader = () => OrthoWorkupOwnerState;

/** Navigation observes the existing owners; this registry never starts or settles a write. */
export function makeOrthoWorkupOwners() {
  const entries = new Set<{ caseId: number; read: OwnerStateReader }>();
  const any = (field: "busy" | "dirty", caseId?: number) => {
    for (const entry of entries) {
      if (caseId !== undefined && entry.caseId !== caseId) continue;
      const state = entry.read();
      if (state.active && state[field]) return true;
    }
    return false;
  };
  return {
    register(caseId: number, read: OwnerStateReader) {
      if (!Number.isSafeInteger(caseId) || caseId <= 0 || caseId > 2147483647) return () => {};
      const entry = { caseId, read };
      entries.add(entry);
      return () => { entries.delete(entry); };
    },
    pending: (caseId?: number) => any("busy", caseId),
    dirty: (caseId?: number) => any("dirty", caseId),
  };
}

export const OrthoWorkupOwnersContext = createContext<ReturnType<typeof makeOrthoWorkupOwners> | null>(null);

/** Getters read synchronous owner latches, never a rendered busy snapshot.
 * Only committed identity/case registrations exist; abandoned renders cannot replace them. */
export function useOrthoWorkupOwner(caseId: number | null | undefined, ownerIdentity: object, read: OwnerStateReader) {
  const registry = useContext(OrthoWorkupOwnersContext);
  const committed = useRef(read);
  useLayoutEffect(() => { committed.current = read; });
  useLayoutEffect(() => {
    if (!registry || caseId == null) return;
    return registry.register(caseId, () => committed.current());
  }, [registry, caseId, ownerIdentity]);
}
