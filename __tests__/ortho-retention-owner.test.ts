import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRetentionRecoveryLedger } from "../lib/ortho-retention-recovery";
import { makeRetentionOwner } from "../lib/ortho-retention-owner";
import { makeRetentionMountOwner } from "../lib/ortho-retention-mount-owner";
import { delivery, expectation, readFixture, row, savedFixture, scope } from "./fixtures/ortho-retention-ui";
beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());
function owner(recovery = makeRetentionRecoveryLedger(), actorId = 17, ownScope = scope) {
  const value = makeRetentionOwner({ ...ownScope, actorId, recovery, authorized: () => true, writable: () => true, admitFresh: () => true, canDiscardQuarantined: () => false, deny() {} });
  value.activate(); return value;
}
function mount(recovery = makeRetentionRecoveryLedger(), access = { authorized: true, writable: true }, ownScope = scope, actorId = 17) {
  const value = makeRetentionMountOwner({ patientId: ownScope.patientId, orthoCaseId: ownScope.orthoCaseId, actorId, ownerKey: `synthetic-${actorId}`,
    recovery, authorized: () => access.authorized, writable: () => access.writable, deny() { access.authorized = false; } });
  value.activate(); return value;
}
describe("parent-owned retention recovery", () => {
  it("retains dirty unsent bytes through retirement without disclosing them to a different actor, patient or bridge", () => {
    const recovery = makeRetentionRecoveryLedger(), first = owner(recovery);
    first.settle("clean"); first.change("private unsent draft"); first.retire(); first.activate(); expect(first.active()).toBe(false); expect(first.document).toBe("");
    for (const other of [owner(recovery, 18), owner(recovery, 17, { ...scope, patientId: 72 }), owner(recovery, 17, { ...scope, clinicalCaseId: 92 })]) {
      expect(other.document).toBe(""); expect(other.recoveryBlocked).toBe(true); expect(other.editable()).toBe(false);
      other.change("replacement"); expect(other.document).toBe(""); other.retire();
    }
    const restored = owner(recovery); expect(restored.document).toBe("private unsent draft"); expect(restored.dirty).toBe(true);
    expect(restored.canLeave(() => false)).toBe(false); expect(restored.document).toBe("private unsent draft");
    expect(restored.canLeave(() => true)).toBe(true); expect(restored.document).toBe("clean"); expect(recovery.needsUnloadWarning()).toBe(false);
  });
  it("retains one exact unresolved command through A→B→A and resolves only authoritative identical replay", async () => {
    const recovery = makeRetentionRecoveryLedger(), first = owner(recovery), expected = expectation(); first.change("authored draft");
    const request = first.begin(expected, "authored draft")!; expect(request).not.toBeNull(); const body = request.body;
    expected.command.reason = "caller later mutated"; expect(request.body).toBe(body);
    first.retire(); const foreign = owner(recovery, 18); expect(foreign.retryExpectation).toBeNull(); expect(foreign.uncertain).toBe(true); expect(foreign.document).toBe("");
    const returned = owner(recovery); expect(returned.busy).toBe(true); expect(returned.document).toBe("authored draft");
    expect(await request.confirmResponse(savedFixture(), 201)).toBe(false); request.finish();
    expect(returned.busy).toBe(false); expect(returned.uncertain).toBe(true); expect(returned.begin(expectation(), returned.document)).toBeNull();
    const retry = returned.beginRetry()!; expect(retry.body).toBe(body); expect(await retry.confirmResponse(savedFixture(expectation(), true), 200)).toBe(true); retry.finish();
    expect(returned.uncertain).toBe(false); expect(returned.document).toBe(""); expect(returned.readVersion).toBe(1); expect(recovery.needsUnloadWarning()).toBe(false);
  });
  it("rejects a stale captured draft, stale fresh admission and late permission/read-generation confirmation", async () => {
    let writable = true, fresh = true;
    const value = makeRetentionOwner({ ...scope, actorId: 17, recovery: makeRetentionRecoveryLedger(), authorized: () => true,
      writable: () => writable, admitFresh: () => fresh, canDiscardQuarantined: () => false, deny() {} }); value.activate(); value.change("new");
    expect(value.begin(expectation(), "old")).toBeNull(); fresh = false; expect(value.begin(expectation(), "new")).toBeNull(); fresh = true;
    const request = value.begin(expectation(), "new")!; const pending = request.confirmResponse(savedFixture(), 201); value.invalidateRead();
    expect(await pending).toBe(false); request.finish(); expect(value.uncertain).toBe(true); expect(value.document).toBe("new");
    writable = false; expect(value.beginRetry()).toBeNull(); expect(value.retryExpectation?.command.clientRequestId).toBe(expectation().command.clientRequestId);
  });
  it("preserves an uncertain request after refusal on retry rather than silently replacing it", () => {
    const value = owner(); value.change("draft"); const first = value.begin(expectation(), "draft")!; first.markUncertain(); first.finish();
    const retry = value.beginRetry()!; retry.refuse(409); retry.finish(); expect(value.uncertain).toBe(true); expect(value.document).toBe("draft");
    expect(value.canLeave(() => true)).toBe(false); expect(value.begin(expectation(), "draft")).toBeNull();
  });
  it("permits a definite fresh refusal to release only the command while retaining dirty facts", () => {
    const value = owner(); value.change("draft"); const request = value.begin(expectation(), "draft")!; request.refuse(409); request.finish();
    expect(value.uncertain).toBe(false); expect(value.dirty).toBe(true); expect(value.document).toBe("draft");
  });
  it("quarantines unresolved command bytes by stable case even after a bridge or patient change", () => {
    const recovery = makeRetentionRecoveryLedger(), original = owner(recovery); const request = original.begin(expectation(), "")!; request.markUncertain(); request.finish(); original.retire();
    for (const changed of [{ ...scope, clinicalCaseId: 92 }, { ...scope, patientId: 72 }]) {
      const next = owner(recovery, 17, changed); expect(next.uncertain).toBe(true); expect(next.retryExpectation).toBeNull();
      expect(next.begin({ ...expectation(), scope: changed }, "")).toBeNull(); expect(next.beginRetry()).toBeNull(); next.retire();
    }
  });
  it("does not evict pending commands or prior draft tokens at bounded capacity", () => {
    const recovery = makeRetentionRecoveryLedger();
    for (let n = 0; n < 16; n++) {
      const ownScope = { ...scope, orthoCaseId: 200 + n }, value = owner(recovery, 17, ownScope);
      const request = value.begin({ ...expectation(), scope: ownScope }, "")!; expect(request).not.toBeNull(); request.markUncertain(); request.finish(); value.retire();
    }
    const blocked = owner(recovery); expect(blocked.begin(expectation(), "")).toBeNull(); expect(blocked.submissionIssue).toBe("recovery_capacity");
    for (let n = 0; n < 16; n++) expect(recovery.forOwner({ ...scope, orthoCaseId: 200 + n }, 17).read()?.uncertain).toBe(true);
    const drafts = makeRetentionRecoveryLedger(), handle = drafts.forDraftOwner(scope, 17), first = handle.write(null, "one", "clean")!;
    const second = handle.write(first, "two", "clean")!; expect(handle.write(first, "stale", "clean")).toBeNull(); expect(handle.discard(first)).toBe(false);
    expect(handle.write(second, "x".repeat(256 * 1024 + 1), "clean")).toBeNull(); expect(handle.read()?.owned?.document).toBe("two");
  });
});
describe("retention strict bridge/read generation binding", () => {
  it("allows no editor before strict GET and closes retained controls throughout a held or failed refresh", async () => {
    const value = mount(); expect(value.retention).toBeNull(); await value.beginRead()!.accept(readFixture());
    const retained = value.retention!; retained.change("private draft"); value.invalidateRead(); const read = value.beginRead()!;
    expect(value.retention).toBeNull(); expect(value.read).toBeNull(); expect(retained.document).toBe(""); expect(retained.editable()).toBe(false);
    retained.change("lost change"); expect(retained.begin(expectation(), "private draft")).toBeNull();
    await expect(read.accept({ ...readFixture(), history: [null] })).rejects.toThrow(); expect(retained.editable()).toBe(false);
    expect(await value.beginRead()!.accept(readFixture())).toBe(true); expect(value.retention).toBe(retained); expect(retained.document).toBe("private draft");
  });
  it("never rebinds a changed bridge or loses a dirty draft; only explicit same-actor discard releases it", async () => {
    const recovery = makeRetentionRecoveryLedger(), value = mount(recovery); await value.beginRead()!.accept(readFixture());
    const retained = value.retention!; retained.change("private original bridge"); value.invalidateRead();
    await expect(value.beginRead()!.accept({ ...readFixture(), clinicalCaseId: 92 })).rejects.toThrow("retention_mount_bridge_changed");
    expect(value.bridgeChanged).toBe(true); expect(retained.editable()).toBe(false); expect(value.canLeave(() => false)).toBe(false);
    expect(recovery.forDraftOwner(scope, 17).read()?.owned?.document).toBe("private original bridge");
    expect(value.discardQuarantinedDraft(() => false)).toBe(false); expect(recovery.needsUnloadWarning()).toBe(true);
    expect(value.discardQuarantinedDraft(() => true)).toBe(true); expect(recovery.needsUnloadWarning()).toBe(false);
  });
  it("keeps readonly and assessment-only histories readable while positively refusing new treatment events", async () => {
    const value = mount(); await value.beginRead()!.accept({ ...readFixture(), status: "assessment", canAppend: true });
    expect(value.read?.status).toBe("assessment"); expect(value.retention?.active()).toBe(true); expect(value.retention?.editable()).toBe(false);
    expect(value.retention?.begin(expectation(), "")).toBeNull();
    const readonly = mount(undefined, { authorized: true, writable: false }); await readonly.beginRead()!.accept(readFixture()); expect(readonly.retention?.editable()).toBe(false);
  });
  it("rejects fresh stale head/target while preserving historical identical retries after a newer head is read", async () => {
    const value = mount(); await value.beginRead()!.accept(readFixture()); const retained = value.retention!;
    const request = retained.begin(expectation(), "")!; request.markUncertain(); request.finish(); value.invalidateRead();
    await value.beginRead()!.accept(readFixture([row(111, 1, delivery())]));
    expect(retained.begin(expectation(), "")).toBeNull(); const retry = retained.beginRetry()!;
    expect(retry.body).toBe(request.body); expect(await retry.confirmResponse(savedFixture(expectation(), true), 200)).toBe(true); retry.finish();
    expect(retained.uncertain).toBe(false);
  });
  it("denial is irreversible even when the parent callback throws and keeps private recovery inaccessible", async () => {
    const recovery = makeRetentionRecoveryLedger(); const value = makeRetentionMountOwner({ ...scope, actorId: 17, ownerKey: "synthetic", recovery,
      authorized: () => true, writable: () => true, deny() { throw new Error("parent callback"); } }); value.activate();
    await value.beginRead()!.accept(readFixture()); const retained = value.retention!; retained.change("private draft");
    expect(() => value.beginRead()!.denied()).toThrow("parent callback"); expect(value.current()).toBe(false); expect(value.read).toBeNull(); expect(retained.document).toBe("");
    value.activate(); expect(value.beginRead()).toBeNull(); expect(recovery.needsUnloadWarning()).toBe(true);
  });
});

it("supersedes older same-generation GET leases without authorizing an out-of-order history", async () => {
  const value = mount(), old = value.beginRead()!, current = value.beginRead()!;
  expect(await old.accept(readFixture())).toBe(false); expect(value.retention).toBeNull();
  expect(await current.accept(readFixture())).toBe(true); expect(value.retention?.editable()).toBe(true);
});
it("closes fresh admission immediately after confirmation until a new strict GET establishes the head", async () => {
  const value = mount(); await value.beginRead()!.accept(readFixture()); const retained = value.retention!;
  const request = retained.begin(expectation(), "")!; expect(await request.confirmResponse(savedFixture(), 201)).toBe(true); request.finish();
  expect(value.retention).toBeNull(); expect(value.read).toBeNull(); expect(retained.begin(expectation(), "")).toBeNull();
  await value.beginRead()!.accept(readFixture([row(111, 1, delivery())])); expect(value.retention).toBe(retained);
  expect(retained.begin(expectation(), "")).toBeNull();
});

it("rejects an older GET captured before a successful save and consumes every acceptance lease once", async () => {
  const value = mount(); const initial = value.beginRead()!; expect(await initial.accept(readFixture())).toBe(true);
  expect(await initial.accept(readFixture())).toBe(false);
  const retained = value.retention!, old = value.beginRead()!;
  const request = retained.begin(expectation(), "")!; expect(await request.confirmResponse(savedFixture(), 201)).toBe(true); request.finish();
  expect(old.current()).toBe(false); expect(await old.accept(readFixture())).toBe(false); expect(value.retention).toBeNull();
  const fresh = value.beginRead()!; expect(await fresh.accept(readFixture([row(111, 1, delivery())]))).toBe(true);
  expect(await fresh.accept(readFixture())).toBe(false); expect(value.read?.history[0].id).toBe(111);
});
it("does not discard an old actor's dirty bytes after authority loss or during a discard dialog", () => {
  let authorized = true;
  const recovery = makeRetentionRecoveryLedger(), value = makeRetentionOwner({ ...scope, actorId: 17, recovery,
    authorized: () => authorized, writable: () => true, admitFresh: () => true, canDiscardQuarantined: () => false, deny() { authorized = false; } });
  value.activate(); value.change("private old actor draft"); authorized = false; const ask = vi.fn(() => true);
  expect(value.canLeave(ask)).toBe(false); expect(ask).not.toHaveBeenCalled(); expect(value.discardQuarantined(ask)).toBe(false);
  expect(recovery.forDraftOwner(scope, 17).read()?.owned?.document).toBe("private old actor draft");
  authorized = true; expect(value.canLeave(() => { authorized = false; return true; })).toBe(false);
  expect(recovery.forDraftOwner(scope, 17).read()?.owned?.document).toBe("private old actor draft");
  authorized = true; value.denied(); expect(value.canLeave(ask)).toBe(false); expect(ask).not.toHaveBeenCalled();
});

it("refuses a full history head before recovery reservation without throwing or inventing a retry", () => {
  const value = owner(), expected = expectation(); expected.previousVersion = 5000; expected.command.expectedHeadId = 999;
  expect(() => value.begin(expected, "")).not.toThrow(); expect(value.begin(expected, "")).toBeNull(); expect(value.uncertain).toBe(false);
});

it.each(["view_detach", "read_timeout"] as const)("cancels the exact GET admission during held hashing for %s without rebinding", async () => {
  const value = mount(), originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let release!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  vi.stubGlobal("crypto", { subtle: { digest(algorithm: Parameters<typeof originalDigest>[0], data: Parameters<typeof originalDigest>[1]) {
    if (++calls !== 1) return originalDigest(algorithm, data);
    entered(); return new Promise<ArrayBuffer>((resolve, reject) => { release = () => { void originalDigest(algorithm, data).then(resolve, reject); }; });
  } } });
  const lease = value.beginRead()!, pending = lease.accept(readFixture([row(101, 1, delivery())]));
  await started; lease.cancel(); expect(lease.current()).toBe(false); release(); expect(await pending).toBe(false); expect(value.retention).toBeNull();
  const newer = value.beginRead()!; lease.cancel(); expect(await newer.accept(readFixture())).toBe(true); expect(value.retention?.editable()).toBe(true);
});
it("cancelling a separate GET lease does not retire an admitted immutable POST", async () => {
  const value = mount(); await value.beginRead()!.accept(readFixture()); const request = value.retention!.begin(expectation(), "")!;
  const read = value.beginRead()!; read.cancel(); expect(request.current()).toBe(true);
  expect(await request.confirmResponse(savedFixture(), 201)).toBe(true); request.finish(); expect(value.uncertain).toBe(false);
});
