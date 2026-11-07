import { describe, expect, it } from "vitest";
import { makeStudyMountOwner } from "../lib/ortho-case-study-mount-owner";
import { makeStudyRecoveryLedger } from "../lib/ortho-case-study-recovery";
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import type { StudySaveExpectation } from "../lib/ortho-case-study-editor-response";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
const template = { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: journeyContentHash(CASE_TEMPLATE_IDENTITY) } as const;
const read = () => ({ ok: true, ...scope, template, head: null, revision: null, history: [], canAppend: true });
function expected(): StudySaveExpectation {
  return { actorId: 7, scope, previousVersion: 0, command: { schemaVersion: 1, clientRequestId: "synthetic_study_mount_0001",
    expectedHead: null, baseDocumentedRevision: null, documentedFrom: null, kind: "draft", reason: "Synthetic mount proof",
    content: { template, identityDisclosure: "case_only", sources: [], groups: [], panels: [], mediaUses: [], comment: "" } } };
}
function setup(actorId = 7, recovery = makeStudyRecoveryLedger()) {
  let authorized = true, writable = true, denied = 0;
  const owner = makeStudyMountOwner({ patientId: scope.patientId, orthoCaseId: scope.orthoCaseId, actorId,
    ownerKey: `synthetic-mount-${actorId}`, recovery, authorized: () => authorized, writable: () => writable, deny: () => { denied++; authorized = false; } });
  owner.activate();
  return { owner, recovery, get denied() { return denied; }, revokeRead: () => { authorized = false; }, revokeWrite: () => { writable = false; } };
}
describe("current canonical saved-study mount binding", () => {
  it("binds only a full verified response with the exact patient and case and positive bridge", async () => {
    const f = setup();
    expect(f.owner.study).toBeNull();
    for (const value of [{ ...read(), patientId: 20 }, { ...read(), orthoCaseId: 42 }, { ...read(), clinicalCaseId: null },
      { ...read(), clinicalCaseId: "51" }, { ...read(), template: { ...template, contentHash: "a".repeat(64) } }]) {
      await expect(f.owner.beginRead()!.accept(value)).rejects.toThrow(); expect(f.owner.study).toBeNull();
    }
    expect(await f.owner.beginRead()!.accept(read())).toBe(true);
    expect(f.owner.clinicalCaseId).toBe(51); expect(f.owner.study?.matches(scope)).toBe(true);
  });
  it("rejects a response begun before read invalidation or permanent retirement", async () => {
    const f = setup(), old = f.owner.beginRead()!;
    f.owner.invalidateRead(); expect(await old.accept(read())).toBe(false); expect(f.owner.study).toBeNull();
    const newer = f.owner.beginRead()!; f.owner.retire(); f.owner.activate();
    expect(await newer.accept(read())).toBe(false); expect(f.owner.current()).toBe(false); expect(f.owner.study).toBeNull();
  });
  it("keeps the same dirty owner through a current reread without declaring a write saved", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const study = f.owner.study!;
    study.settle("clean"); study.change("local draft"); f.owner.invalidateRead();
    expect(f.owner.study).toBeNull(); expect(f.owner.needsUnloadWarning()).toBe(true);
    await f.owner.beginRead()!.accept(read()); expect(f.owner.study).toBe(study); expect(study.document).toBe("local draft");
    expect(study.dirty).toBe(true); expect(f.owner.canLeave(() => false)).toBe(false);
  });
  it("keeps unresolved exact bytes across A retirement and a newly verified same-actor A", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const study = f.owner.study!;
    study.change("private unresolved draft"); const operation = study.begin(expected())!; expect(operation).not.toBeNull();
    const body = operation.body; f.owner.retire(); operation.markUncertain(); operation.finish();
    const same = setup(7, f.recovery); await same.owner.beginRead()!.accept(read());
    expect(same.owner.study!.document).toBe("private unresolved draft"); expect(same.owner.study!.begin(expected())).toBeNull();
    const retry = same.owner.study!.beginRetry()!; expect(retry.body).toBe(body); retry.markUncertain(); retry.finish();
    same.owner.retire();
    const other = setup(8, f.recovery); await other.owner.beginRead()!.accept(read());
    expect(other.owner.study!.document).toBe(""); expect(other.owner.study!.retryExpectation).toBeNull();
    expect(other.owner.study!.beginRetry()).toBeNull(); expect(other.owner.canLeave(() => true)).toBe(false);
  });
  it("permanently blocks this binding on bridge change without rebasing an old owner", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const old = f.owner.study!;
    old.change("private draft"); f.owner.invalidateRead();
    await expect(f.owner.beginRead()!.accept({ ...read(), clinicalCaseId: 52 })).rejects.toThrow("study_mount_bridge_changed");
    expect(f.owner.bridgeChanged).toBe(true); expect(f.owner.study).toBeNull(); expect(old.active()).toBe(false);
    f.owner.activate(); expect(f.owner.beginRead()).toBeNull();
    expect(old.begin(expected())).toBeNull(); expect(old.beginRetry()).toBeNull();
    expect(f.owner.needsUnloadWarning()).toBe(true); expect(f.owner.canLeave(() => false)).toBe(false);
    const stored = f.recovery.forDraftOwner(scope, 7).read();
    expect(stored?.owned?.document).toBe("private draft"); expect(stored?.owned?.clean).toBe("");
    expect(f.owner.discardQuarantinedDraft(() => false)).toBe(false);
    expect(f.recovery.forDraftOwner(scope, 7).read()?.owned?.document).toBe("private draft");
    expect(f.owner.discardQuarantinedDraft(() => true)).toBe(true);
    expect(f.recovery.forDraftOwner(scope, 7).read()).toBeNull();
    expect(f.owner.needsUnloadWarning()).toBe(false); expect(f.owner.beginRead()).toBeNull();
  });
  it("suspends all retained inner callbacks until the exact new generation is verified", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const old = f.owner.study!;
    old.settle("saved"); old.change("retained local edit"); const change = old.change, begin = old.begin, retry = old.beginRetry;
    f.owner.invalidateRead(); expect(old.active()).toBe(false); expect(old.editable()).toBe(false);
    change("stale overwrite"); old.settle("stale clean"); expect(begin(expected())).toBeNull(); expect(retry()).toBeNull();
    await expect(f.owner.beginRead()!.accept({ ...read(), template: { ...template, contentHash: "0".repeat(64) } })).rejects.toThrow();
    expect(old.active()).toBe(false); expect(begin(expected())).toBeNull();
    expect(f.recovery.forDraftOwner(scope, 7).read()?.owned?.document).toBe("retained local edit");
    await f.owner.beginRead()!.accept(read()); expect(f.owner.study).toBe(old); expect(old.document).toBe("retained local edit");
    expect(old.editable()).toBe(true);
  });
  it("keeps pending exact bytes uncertain through invalidation and admits retry only after rebind", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const old = f.owner.study!;
    old.change("pending source"); const operation = old.begin(expected())!, body = operation.body;
    f.owner.invalidateRead(); expect(operation.current()).toBe(false); expect(old.beginRetry()).toBeNull();
    operation.finish(); expect(f.owner.uncertain).toBe(true); expect(f.owner.busy).toBe(false);
    await f.owner.beginRead()!.accept(read()); const retry = old.beginRetry()!;
    expect(retry.body).toBe(body); retry.markUncertain(); retry.finish();
  });
  it("preserves never-submitted edits on denial/retirement and restores only verified exact actor and scope", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const old = f.owner.study!;
    old.settle("saved"); old.change("private never submitted edit");
    f.owner.beginRead()!.denied(); f.owner.retire(); expect(old.document).toBe(""); expect(f.recovery.needsUnloadWarning()).toBe(true);
    const foreign = setup(8, f.recovery); await foreign.owner.beginRead()!.accept(read());
    expect(foreign.owner.study!.document).toBe(""); expect(foreign.owner.study!.recoveryBlocked).toBe(true);
    expect(foreign.owner.study!.begin(expected())).toBeNull(); foreign.owner.retire();
    const changedBridge = setup(7, f.recovery); await changedBridge.owner.beginRead()!.accept({ ...read(), clinicalCaseId: 52 });
    expect(changedBridge.owner.study!.document).toBe(""); expect(changedBridge.owner.study!.editable()).toBe(false);
    expect(changedBridge.owner.study!.begin({ ...expected(), scope: { ...scope, clinicalCaseId: 52 } })).toBeNull(); changedBridge.owner.retire();
    const same = setup(7, f.recovery); await same.owner.beginRead()!.accept(read());
    expect(same.owner.study!.document).toBe("private never submitted edit"); expect(same.owner.study!.dirty).toBe(true);
  });
  it("denies immediately and gates readonly and revoked current authority independently", async () => {
    const f = setup(); await f.owner.beginRead()!.accept(read()); const study = f.owner.study!;
    f.revokeWrite(); expect(study.begin(expected())).toBeNull(); expect(f.owner.study).toBe(study);
    f.owner.beginRead()!.denied(); expect(f.denied).toBe(1); expect(f.owner.study).toBeNull(); expect(study.active()).toBe(false);
    const other = setup(); const pending = other.owner.beginRead()!; other.revokeRead();
    expect(await pending.accept(read())).toBe(false); expect(other.owner.study).toBeNull();
  });
  it("refuses missing or invalid stable actor IDs without username fallbacks", () => {
    for (const actorId of [0, -1, NaN, Infinity, 1.5]) expect(() => setup(actorId)).toThrow("invalid_study_mount_scope");
  });
});
