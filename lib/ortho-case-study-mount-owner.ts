import { makeStudyOwner, type StudyOwner } from "./ortho-case-study-owner";
import type { StudyRecoveryLedger } from "./ortho-case-study-recovery";
import { verifyStudyEditorRead } from "./ortho-case-study-editor-response";
import { journeyId } from "./ortho-case-journey-records";

/** A parent-owned case binding. A successful current server read supplies the
 * bridge; neither a display label nor an old captured patient authorizes it. */
export function makeStudyMountOwner(input: {
  patientId: number; orthoCaseId: number; actorId: number; ownerKey: string;
  recovery: StudyRecoveryLedger; authorized(): boolean; writable(): boolean; deny(): void;
}) {
  if (![input.patientId, input.orthoCaseId, input.actorId].every(journeyId) || !input.ownerKey) throw new Error("invalid_study_mount_scope");
  let active = false, retired = false, denied = false, bridgeChanged = false, generation = 0;
  let acceptedGeneration: number | null = null, clinicalCaseId: number | null = null, study: StudyOwner | null = null;
  let unsubscribeStudy: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const current = () => active && !retired && !denied && !bridgeChanged && input.authorized();
  const verified = () => current() && acceptedGeneration === generation && clinicalCaseId !== null;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const revoke = () => {
    denied = true; acceptedGeneration = null;
    try { input.deny(); } finally { notify(); }
  };
  return {
    patientId: input.patientId, orthoCaseId: input.orthoCaseId, actorId: input.actorId, ownerKey: input.ownerKey,
    get generation() { return generation; }, get retired() { return retired; }, get bridgeChanged() { return bridgeChanged; },
    get busy() { return study?.busy ?? false; }, get uncertain() { return study?.uncertain ?? false; },
    get study() { return current() && acceptedGeneration === generation ? study : null; },
    get clinicalCaseId() { return current() && acceptedGeneration === generation ? clinicalCaseId : null; },
    current,
    activate() { if (!retired && !denied) active = true; },
    beginRead() {
      if (!current()) return null;
      const captured = generation;
      return {
        current: () => current() && generation === captured,
        denied() { if (current() && generation === captured) { if (study) study.denied(); else revoke(); } },
        async accept(raw: unknown) {
          if (!current() || generation !== captured) return false;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_study_mount_response");
          const value = raw as Record<string, unknown>;
          if (value.patientId !== input.patientId || value.orthoCaseId !== input.orthoCaseId || !journeyId(value.clinicalCaseId)) throw new Error("study_mount_scope_changed");
          const bridge = value.clinicalCaseId;
          // Full strict response/history/template/authored hash verification is
          // retained. This is UI binding, never a server authority substitute.
          await verifyStudyEditorRead(raw, { patientId: input.patientId, orthoCaseId: input.orthoCaseId, clinicalCaseId: bridge });
          if (!current() || generation !== captured) return false;
          if (clinicalCaseId !== null && bridge !== clinicalCaseId) {
            // Do not re-target an unresolved command or silently create a second
            // owner for a different bridge. Current server repair/reopen is needed.
            bridgeChanged = true; acceptedGeneration = null; study?.invalidateRead(); notify();
            throw new Error("study_mount_bridge_changed");
          }
          if (!study) {
            clinicalCaseId = bridge;
            study = makeStudyOwner({ patientId: input.patientId, orthoCaseId: input.orthoCaseId, clinicalCaseId: bridge,
              actorId: input.actorId, recovery: input.recovery, authorized: verified,
              writable: () => verified() && input.writable(), deny: revoke });
            unsubscribeStudy = study.subscribe(notify);
          }
          acceptedGeneration = captured; study.activate(); notify(); return true;
        },
      };
    },
    invalidateRead() {
      generation++; acceptedGeneration = null; study?.invalidateRead(); notify();
    },
    discardQuarantinedDraft(confirmDiscard: () => boolean) {
      if (!active || retired || denied || !bridgeChanged || !input.authorized() || !study) return false;
      const captured = generation;
      return study.canLeave(() => { const accepted = confirmDiscard(); return accepted && active && !retired && !denied
        && bridgeChanged && generation === captured && input.authorized(); });
    },
    canLeave(confirmDiscard: () => boolean) { return study?.canLeave(confirmDiscard) ?? true; },
    needsUnloadWarning: () => study?.needsUnloadWarning() ?? false,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire() {
      if (retired) return;
      active = false; retired = true; generation++; acceptedGeneration = null;
      unsubscribeStudy?.(); unsubscribeStudy = null; study?.retire(); listeners.clear();
    },
  };
}
export type StudyMountOwner = ReturnType<typeof makeStudyMountOwner>;
