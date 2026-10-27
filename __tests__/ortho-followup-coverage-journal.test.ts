import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followupCoverageJournal, restoreFollowupCoverage, type FollowupCoverageAttempt } from "../lib/ortho-followup-coverage-recovery";

// Execute the production IndexedDB journal, using only a small serialized IDB API
// adapter. This is transaction/command coverage, not real Chromium storage proof.
function indexedDbAdapter() {
  const rows = new Map<string, unknown>();
  let previous = Promise.resolve();
  const db = {
    close() {}, createObjectStore() {},
    transaction() {
      let release!: () => void;
      const before = previous; previous = new Promise<void>(resolve => { release = resolve; });
      let aborted = false, staged: { scope: string } | null = null;
      const tx = {
        oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void),
        abort() { aborted = true; queueMicrotask(() => { tx.onabort?.(); release(); }); },
        objectStore() { return {
          get(key: string) {
            const request = { result: undefined as unknown, onsuccess: null as null | (() => void) };
            void before.then(() => {
              request.result = structuredClone(rows.get(key));request.onsuccess?.();
              queueMicrotask(() => { if (!aborted) { if (staged) rows.set(staged.scope, structuredClone(staged));tx.oncomplete?.();release(); } });
            });
            return request;
          },
          getAll() {
            const request = { result: undefined as unknown, onsuccess: null as null | (() => void) };
            void before.then(() => {
              request.result = structuredClone([...rows.values()]);request.onsuccess?.();
              queueMicrotask(() => { if (!aborted) { tx.oncomplete?.();release(); } });
            });
            return request;
          },
          put(row: { scope: string }) { staged = structuredClone(row); },
        }; },
      };
      return tx;
    },
  };
  return { seed(scope: string, value: unknown) { rows.set(scope, value); }, open() {
    const request = { result: db, onsuccess: null as null | (() => void), onerror: null, onblocked: null, onupgradeneeded: null };
    queueMicrotask(() => request.onsuccess?.());return request;
  } };
}
const scope = { actor: "synthetic-admin", patientId: 1 };
const attempt: FollowupCoverageAttempt = { ...scope, orthoCaseId: 2, command: {
  schemaVersion: 1, commandId: "12345678-1234-4123-8123-123456789012", expectedRevisionId: null,
  source: { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, planId: 4, planItemId: 5, invoiceId: 6 },
  expectedSourceFingerprint: "a".repeat(64), scope: "routine_adjustments", decision: "included", reason: "Synthetic agreed scope",
} };
beforeEach(() => vi.stubGlobal("indexedDB", indexedDbAdapter()));
afterEach(() => vi.unstubAllGlobals());
describe("production shared journal accepts and arbitrates orthodontic scope commands", () => {
  it("reserves then reloads exact coverage intent through a fresh module instance", async () => {
    const journal = await import("../lib/financial-command-journal"), command = followupCoverageJournal(attempt);
    expect(await journal.reserveFinancialCommand(scope, 0, command)).toEqual({ revision: 0, command });
    vi.resetModules();const reloaded = await import("../lib/financial-command-journal");
    const saved = await reloaded.readFinancialJournal(scope);expect(saved).toEqual({ revision: 0, command });
    expect(restoreFollowupCoverage(saved.command!, scope.actor, scope.patientId)).toEqual(attempt);
    expect(await reloaded.readFinancialJournal({ ...scope, actor: "other" })).toEqual({ revision: 0, command: null });
  });
  it.each(["invoice", "collection"] as const)("atomically blocks competing %s commands until exact acknowledgment", async kind => {
    const journal = await import("../lib/financial-command-journal"), command = followupCoverageJournal(attempt);
    const competing = { kind, key: `synthetic-${kind}`, original: '{"patientId":1}', payload: '{"patientId":1}' };
    await journal.reserveFinancialCommand(scope, 0, command);
    const results = await Promise.all([journal.reserveFinancialCommand(scope, 0, command), journal.reserveFinancialCommand(scope, 0, competing)]);
    expect(results[0]).toEqual(results[1]);expect(results[0].command).toEqual(command);
    await expect(journal.acknowledgeFinancialCommand(scope, competing)).rejects.toMatchObject({ code: "changed" });
    expect(await journal.readFinancialJournal(scope)).toEqual({ revision: 0, command });
    expect(await journal.acknowledgeFinancialCommand(scope, command)).toEqual({ revision: 1, command: null });
    await expect(journal.reserveFinancialCommand(scope, 0, competing)).rejects.toMatchObject({ code: "changed" });
    expect(await journal.reserveFinancialCommand(scope, 1, competing)).toEqual({ revision: 1, command: competing });
    expect(await journal.reserveFinancialCommand(scope, 1, command)).toEqual({ revision: 1, command: competing });
  });
  it("discovers only exact actor scopes without exposing or validating a foreign actor's corrupted payload", async () => {
    const adapter=indexedDbAdapter();vi.stubGlobal("indexedDB",adapter);
    const journal=await import("../lib/financial-command-journal"),command=followupCoverageJournal(attempt);
    await journal.reserveFinancialCommand(scope,0,command);
    const otherScope={actor:scope.actor,patientId:2};await journal.reserveFinancialCommand(otherScope,0,{...command,key:'another-synthetic-command'});
    adapter.seed(JSON.stringify(['foreign-actor',999]),{scope:JSON.stringify(['foreign-actor',999]),revision:-100,command:'private-invalid-data'});
    const found=await journal.readFinancialJournalsForActor(scope.actor);
    expect(found.map(entry=>entry.scope)).toEqual([scope,otherScope]);
    expect(found[0].journal.command).toEqual(command);
    expect(await journal.readFinancialJournalsForActor('unknown-actor')).toEqual([]);
    expect(await journal.readFinancialJournal(scope)).toEqual({revision:0,command});
    adapter.seed(JSON.stringify([scope.actor,3]),{scope:JSON.stringify([scope.actor,3]),revision:-100,command:'invalid'});
    await expect(journal.readFinancialJournalsForActor(scope.actor)).rejects.toMatchObject({code:'invalid'});
  });

});
