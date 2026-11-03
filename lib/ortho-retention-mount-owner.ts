import { makeRetentionOwner, type RetentionOwner } from "./ortho-retention-owner";
import type { RetentionRecoveryLedger } from "./ortho-retention-recovery";
import { verifyRetentionRead, retentionTreatmentStatus, type RetentionRead } from "./ortho-retention-client";
import { journeyId } from "./ortho-case-journey-records";

/** A parent-owned case binding. A successful current server read supplies the
 * bridge; neither a display label nor an old captured patient authorizes it. */
export function makeRetentionMountOwner(input: {
  patientId: number; orthoCaseId: number; actorId: number; ownerKey: string;
  recovery: RetentionRecoveryLedger; authorized(): boolean; writable(): boolean; deny(): void;
}) {
  if (![input.patientId, input.orthoCaseId, input.actorId].every(journeyId) || !input.ownerKey) throw new Error("invalid_retention_mount_scope");
  let active = false, retired = false, denied = false, bridgeChanged = false, generation = 0;
  let acceptedGeneration: number | null = null, clinicalCaseId: number | null = null, retention: RetentionOwner | null = null;
  let unsubscribeRetention: (() => void) | null = null;
  let acceptedRead: RetentionRead | null = null, acceptedOwnerReadVersion = 0, readTicket = 0;
  const listeners = new Set<() => void>();
  const current = () => active && !retired && !denied && !bridgeChanged && input.authorized();
  const verified = () => current() && acceptedGeneration === generation && clinicalCaseId !== null
    && (retention?.readVersion ?? 0) === acceptedOwnerReadVersion;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const revoke = () => {
    denied = true; acceptedGeneration = null;
    try { input.deny(); } finally { notify(); }
  };
  return {
    patientId: input.patientId, orthoCaseId: input.orthoCaseId, actorId: input.actorId, ownerKey: input.ownerKey,
    get readVersion() { return retention?.readVersion ?? 0; },
    get generation() { return generation; }, get retired() { return retired; }, get bridgeChanged() { return bridgeChanged; },
    get busy() { return retention?.busy ?? false; }, get uncertain() { return retention?.uncertain ?? false; },
    get read() { return verified() ? acceptedRead : null; },
    get retention() { return verified() ? retention : null; },
    get clinicalCaseId() { return verified() ? clinicalCaseId : null; },
    current,
    activate() { if (!retired && !denied) active = true; },
    beginRead() {
      if (!current()) return null;
      const captured = generation, capturedReadVersion = retention?.readVersion ?? 0, ticket = ++readTicket;
      let consumed = false, cancelled = false;
      const snapshotCurrent = () => !cancelled && current() && generation === captured && readTicket === ticket && (retention?.readVersion ?? 0) === capturedReadVersion;
      const ownsRead = () => !consumed && snapshotCurrent();
      return {
        // Context freshness remains observable after a malformed response so the
        // view can show its error; acceptance itself is strictly one-shot.
        current: snapshotCurrent,
        cancel() { cancelled = true; },
        denied() { if (ownsRead()) { consumed = true; if (retention) retention.denied(); else revoke(); } },
        async accept(raw: unknown) {
          if (!ownsRead()) return false;
          consumed = true;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_retention_mount_response");
          const value = raw as Record<string, unknown>;
          if (value.patientId !== input.patientId || value.orthoCaseId !== input.orthoCaseId || !journeyId(value.clinicalCaseId)) throw new Error("retention_mount_scope_changed");
          const bridge = value.clinicalCaseId;
          // Full strict response/history/device/content hash verification is
          // retained. This is UI binding, never a server authority substitute.
          const checked = await verifyRetentionRead(raw, { patientId: input.patientId, orthoCaseId: input.orthoCaseId, clinicalCaseId: bridge });
          if (!snapshotCurrent()) return false;
          if (clinicalCaseId !== null && bridge !== clinicalCaseId) {
            // Do not re-target an unresolved command or silently create a second
            // owner for a different bridge. Current server repair/reopen is needed.
            bridgeChanged = true; acceptedGeneration = null; retention?.invalidateRead(); notify();
            throw new Error("retention_mount_bridge_changed");
          }
          if (!retention) {
            clinicalCaseId = bridge;
            retention = makeRetentionOwner({ patientId: input.patientId, orthoCaseId: input.orthoCaseId, clinicalCaseId: bridge,
              actorId: input.actorId, recovery: input.recovery, authorized: verified,
              writable: () => verified() && input.writable() && acceptedRead?.canAppend === true && retentionTreatmentStatus(acceptedRead.status),
              admitFresh(expected) {
                if (!verified() || !acceptedRead || expected.previousVersion !== (acceptedRead.history[0]?.version ?? 0)
                  || expected.command.expectedHeadId !== (acceptedRead.history[0]?.id ?? null)) return false;
                const command = expected.command, target = "device" in command.content ? command.content.device : command.content.kind === "device_replacement" ? command.content.replaces : null;
                if (target && !acceptedRead.devices.some(d => d.deviceId === target.deviceId && d.lastEventId === target.expectedDeviceRevisionId)) return false;
                if (command.supersedesEntryId !== null && !acceptedRead.currentEvents.some(e => e.id === command.supersedesEntryId && e.content.kind === command.content.kind)) return false;
                if (command.content.kind === "device_replacement" && command.supersedesEntryId === null
                  && acceptedRead.devices.some(d => d.replacedDeviceId === target?.deviceId)) return false;
                return true;
              }, canDiscardQuarantined: () => active && !retired && !denied && bridgeChanged && input.authorized(), deny: revoke });
            unsubscribeRetention = retention.subscribe(notify);
          }
          // Detached parser output is frozen once. Reading UI metadata does not
          // repeatedly copy an entire bounded clinical history on every render.
          const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } };
          freeze(checked); acceptedRead = checked; acceptedGeneration = captured; acceptedOwnerReadVersion = retention.readVersion; retention.activate(); notify(); return true;
        },
      };
    },
    invalidateRead() {
      generation++; acceptedGeneration = null; retention?.invalidateRead(); notify();
    },
    discardQuarantinedDraft(confirmDiscard: () => boolean) {
      if (!active || retired || denied || !bridgeChanged || !input.authorized() || !retention) return false;
      const captured = generation;
      return retention.discardQuarantined(() => { const accepted = confirmDiscard(); return accepted && active && !retired && !denied
        && bridgeChanged && generation === captured && input.authorized(); });
    },
    canLeave(confirmDiscard: () => boolean) { return retention?.canLeave(confirmDiscard) ?? true; },
    needsUnloadWarning: () => retention?.needsUnloadWarning() ?? false,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire() {
      if (retired) return;
      active = false; retired = true; generation++; acceptedGeneration = null;
      unsubscribeRetention?.(); unsubscribeRetention = null; retention?.retire(); listeners.clear();
    },
  };
}
export type RetentionMountOwner = ReturnType<typeof makeRetentionMountOwner>;
