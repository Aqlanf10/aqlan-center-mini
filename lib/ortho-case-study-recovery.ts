import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { journeyId, type JourneyScope } from "./ortho-case-journey-records";
import type { StudySaveExpectation } from "./ortho-case-study-editor-response";
interface RecoveryRecord {
  token: object; actorId: number; patientId: number; expected: string; body: string; document: string; clean: string;
  pending: boolean; uncertain: boolean; bytes: number;
}
/** In-memory parent-owned recovery. Never global/module-wide and never scoped
 * only by role/name. It must survive view/case switches. A hard reload destroys
 * it: beforeunload warning is required; durable reload recovery is a release gap. */
export function makeStudyRecoveryLedger() {
  // Unsubmitted edits have a separate bounded lifetime. Stable Ortho identity
  // quarantines them across actor, bridge and patient changes without rebasing.
  const drafts = new Map<number, { token: object; actorId: number; patientId: number; clinicalCaseId: number; document: string; clean: string; bytes: number }>();
  const records = new Map<string, RecoveryRecord>(), listeners = new Map<string, Set<() => void>>();
  const key = (scope: JourneyScope) => {
    if (![scope.patientId, scope.orthoCaseId, scope.clinicalCaseId].every(journeyId)) throw new Error("invalid_study_recovery_scope");
    // Stable case identity quarantines unresolved writes even after patient merge.
    return `${scope.orthoCaseId}:${scope.clinicalCaseId}`;
  };
  const notify = (scopeKey: string) => { for (const listener of [...(listeners.get(scopeKey) ?? [])]) listener(); };
  return {
    forDraftOwner(scope: JourneyScope, actorId: number) {
      key(scope); if (!journeyId(actorId)) throw new Error("invalid_study_recovery_actor");
      const owned = () => { const row = drafts.get(scope.orthoCaseId); return row && row.actorId === actorId
        && row.patientId === scope.patientId && row.clinicalCaseId === scope.clinicalCaseId ? row : null; };
      return {
        read() { const row = drafts.get(scope.orthoCaseId); if (!row) return null;
          const value = owned(); return { foreign: !value, owned: value ? { token: value.token, document: value.document, clean: value.clean } : null }; },
        write(expectedToken: object | null, document: string, clean: string) {
          const row = drafts.get(scope.orthoCaseId), prior = owned();
          if (row && (!prior || prior.token !== expectedToken) || !row && expectedToken !== null) return null;
          if (typeof document !== "string" || typeof clean !== "string" || document.length > 2 * 1024 * 1024 || clean.length > 2 * 1024 * 1024) return null;
          const lengths = [document, clean].map(value => new TextEncoder().encode(value).length), bytes = lengths[0] + lengths[1];
          if (lengths.some(value => value > 2 * 1024 * 1024) || !row && drafts.size >= 16
            || [...drafts.values()].reduce((sum, value) => sum + value.bytes, bytes - (row?.bytes ?? 0)) > 16 * 1024 * 1024) return null;
          const token = Object.freeze({});
          drafts.set(scope.orthoCaseId, { token, actorId, patientId: scope.patientId, clinicalCaseId: scope.clinicalCaseId, document, clean, bytes });
          return token;
        },
        discard(token: object) { const row = owned(); if (!row || row.token !== token) return false; drafts.delete(scope.orthoCaseId); return true; },
      };
    },
    forOwner(scope: JourneyScope, actorId: number) {
      if (!journeyId(actorId)) throw new Error("invalid_study_recovery_actor"); const scopeKey = key(scope);
      const own = (token: object) => { const row = records.get(scopeKey); return row?.token === token && row.actorId === actorId && row.patientId === scope.patientId ? row : null; };
      return {
        read() {
          const row = records.get(scopeKey); if (!row) return null;
          return { pending: row.pending, uncertain: row.uncertain, foreign: row.actorId !== actorId || row.patientId !== scope.patientId,
            owned: row.actorId !== actorId || row.patientId !== scope.patientId ? null : { token: row.token, expected: JSON.parse(row.expected) as StudySaveExpectation,
              body: row.body, document: row.document, clean: row.clean } };
        },
        reserve(expected: StudySaveExpectation, body: string, document: string, clean: string) {
          const expectation = canonicalJourneyJSON(expected);
          if ([expectation, body, document, clean].some(value => value.length > 2 * 1024 * 1024)) return null;
          const encoded = [expectation, body, document, clean].map(value => new TextEncoder().encode(value).length), bytes = encoded.reduce((sum, n) => sum + n, 0);
          if (records.has(scopeKey) || records.size >= 16 || encoded.some(n => n > 2 * 1024 * 1024)
            || [...records.values()].reduce((sum, row) => sum + row.bytes, bytes) > 16 * 1024 * 1024) return null;
          const row: RecoveryRecord = { token: Object.freeze({}), actorId, patientId: scope.patientId, expected: expectation, body, document, clean, pending: true, uncertain: false, bytes };
          records.set(scopeKey, row); notify(scopeKey); return row.token;
        },
        retry(token: object) { const row = own(token); if (!row || row.pending || !row.uncertain) return false; row.pending = true; notify(scopeKey); return true; },
        markUncertain(token: object) { const row = own(token); if (row) { row.uncertain = true; notify(scopeKey); } },
        settle(token: object, resolved: boolean) {
          const row = own(token); if (!row) return;
          if (resolved) records.delete(scopeKey); else { row.pending = false; row.uncertain = true; }
          notify(scopeKey);
        },
        subscribe(listener: () => void) {
          let set = listeners.get(scopeKey); if (!set) { set = new Set(); listeners.set(scopeKey, set); }
          set.add(listener); return () => { set!.delete(listener); if (!set!.size) listeners.delete(scopeKey); };
        },
      };
    },
    needsUnloadWarning: () => records.size > 0 || drafts.size > 0,
  };
}
export type StudyRecoveryLedger = ReturnType<typeof makeStudyRecoveryLedger>;
