import { describe, expect, it } from "vitest";
import { makeStudyRecoveryLedger, type StudyRecoveryLedger } from "../lib/ortho-case-study-recovery";
import { makeStudyOwner } from "../lib/ortho-case-study-owner";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import type { StudySaveExpectation } from "../lib/ortho-case-study-editor-response";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function expectation(): StudySaveExpectation {
  return { scope, actorId: 7, previousVersion: 0, command: { schemaVersion: 1, clientRequestId: "synthetic_study_command_001",
    expectedHead: null, baseDocumentedRevision: null, documentedFrom: null, kind: "draft", reason: "Synthetic draft",
    content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: journeyContentHash(CASE_TEMPLATE_IDENTITY) },
      identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "", panels: [
        { instanceId: "cover1", layoutKey: "cover", state: "not_recorded", included: true, sourceKeys: [], images: [], comment: "" }] } } };
}
function saved(expected: StudySaveExpectation, replayed = false) {
  return { ok: true, replayed, ...scope, revision: { ...scope, actorId: expected.actorId, id: 91, version: 1, kind: "draft", contentHash: "a".repeat(64),
    predecessorId: null, documentedFromId: null, baseDocumentedId: null, createdAt: "2026-10-01T00:00:00.000Z",
    capturedAt: "2026-10-01T00:00:00.000Z", caseStatusAtCapture: "active",
    reason: expected.command.reason, authored: expected.command.content, authoredHash: journeyContentHash(expected.command.content) } };
}
const acknowledgment = (expected:StudySaveExpectation) => ({ok:true,scope:expected.scope,actorId:expected.actorId,
  identity:{id:1,commandId:expected.command.clientRequestId,requestFingerprint:journeyContentHash(expected.command)},state:"committed",acknowledged:true});
const owner = (recovery: StudyRecoveryLedger = makeStudyRecoveryLedger(), actorId = 7) => { const value = makeStudyOwner({ ...scope, recovery, actorId, authorized: () => true, writable: () => true, deny() {} }); value.activate(); return value; };
describe("parent-owned persisted study lifetime", () => {
  it("blocks pending navigation and duplicate commands without changing authored bytes", () => {
    const value = owner(); value.settle("saved"); value.change("edited");
    const request = value.begin(expectation()); expect(request).not.toBeNull();
    expect(value.begin(expectation())).toBeNull(); expect(value.canLeave(() => true)).toBe(false);
    value.change("lost edit"); expect(value.document).toBe("edited");
    request!.refuse(409); request!.finish(); expect(value.busy).toBe(false); expect(value.uncertain).toBe(true);
    expect(value.document).toBe("edited"); expect(value.dirty).toBe(true);
  });
  it("retains durable uncertainty for an HTTP conflict without treating status as proof of rollback", () => {
    const value=owner();value.settle("saved");value.change("explicit submitted text");
    const operation=value.begin(expectation())!;operation.refuse(409);operation.finish();
    expect(value.uncertain).toBe(true);expect(value.canRetry()).toBe(true);
    expect(value.begin(expectation())).toBeNull();expect(value.document).toBe("explicit submitted text");
  });
  it("preserves dirty data on cancel and reverts only after explicit confirmed discard", () => {
    const value = owner(); value.settle("saved"); value.change("edited");
    expect(value.canLeave(() => false)).toBe(false); expect(value.document).toBe("edited");
    expect(value.canLeave(() => true)).toBe(true); expect(value.document).toBe("saved"); expect(value.dirty).toBe(false);
  });
  it("retains exact frozen request bytes after uncertainty and permits only same-command retry", async () => {
    const value = owner(), expected = expectation(); value.settle("saved"); value.change("local");
    const first = value.begin(expected)!; const bytes = first.body;
    first.markUncertain(); first.finish(); expect(value.uncertain).toBe(true);
    expect(value.canLeave(() => true)).toBe(false); value.change("new request"); expect(value.document).toBe("local");
    expect(value.begin({ ...expected, command: { ...expected.command, clientRequestId: "different_command_001" } })).toBeNull();
    const retry = value.beginRetry()!; expect(retry.body).toBe(bytes);
    expect(await retry.confirmResponse(saved(expected, true), 200)).toBe(true); expect(await retry.confirmAcknowledgment(acknowledgment(expected))).toBe(true); retry.finish();
    expect(value.uncertain).toBe(false); expect(value.document).toBe(""); expect(value.readVersion).toBe(1);
  });
  it("notifies a remounted view when its old outstanding POST completes, without touching unrelated owners", async () => {
    const value = owner(), other = owner(), expected = expectation(); value.change("local A"); other.change("local B");
    let oldNotifications = 0, currentNotifications = 0;
    const unsubscribe = value.subscribe(() => oldNotifications++);
    const request = value.begin(expected)!; unsubscribe(); const oldCount = oldNotifications;
    const stop = value.subscribe(() => currentNotifications++);
    expect(await request.confirmResponse(saved(expected), 201)).toBe(true); expect(await request.confirmAcknowledgment(acknowledgment(expected))).toBe(true); request.finish(); stop();
    expect(oldNotifications).toBe(oldCount); expect(currentNotifications).toBe(1);
    expect(value.readVersion).toBe(1); expect(other.document).toBe("local B");
  });
  it("preserves a lost/late POST through A→B→A and only resolves the exact original command", async () => {
    const ledger = makeStudyRecoveryLedger(), firstA = owner(ledger), expected = expectation();
    firstA.change("unresolved A draft"); const pending = firstA.begin(expected)!; const originalBody = pending.body;
    firstA.retire(); firstA.activate(); expect(firstA.active()).toBe(false);
    const newA = owner(ledger); expect(newA.document).toBe("unresolved A draft");
    newA.change("replacement command"); expect(newA.document).toBe("unresolved A draft");
    expect(newA.busy).toBe(true); expect(newA.begin(expected)).toBeNull();
    expect(await pending.confirmResponse(saved(expected), 201)).toBe(false); pending.finish();
    expect(newA.busy).toBe(false); expect(newA.uncertain).toBe(true); expect(ledger.needsUnloadWarning()).toBe(true);
    const replay = newA.beginRetry()!; expect(replay.body).toBe(originalBody);
    expect(await replay.confirmResponse(saved(expected, true), 200)).toBe(true); expect(await replay.confirmAcknowledgment(acknowledgment(expected))).toBe(true); replay.finish();
    expect(newA.uncertain).toBe(false); expect(newA.document).toBe(""); expect(ledger.needsUnloadWarning()).toBe(false);
  });
  it("does not disclose a retired actor's pending body or permit a replacement command to another actor", () => {
    const ledger = makeStudyRecoveryLedger(), original = owner(ledger, 7);
    original.change("private pending content"); const pending = original.begin(expectation())!; original.retire(); pending.finish();
    const other = owner(ledger, 8);
    expect(other.document).toBe(""); expect(other.retryExpectation).toBeNull(); expect(other.canRetry()).toBe(false);
    expect(other.uncertain).toBe(true); expect(other.begin(expectation())).toBeNull();
  });
  it("quarantines an unresolved clean-document request across bridge replacement", () => {
    const ledger = makeStudyRecoveryLedger(), original = owner(ledger), expected = expectation();
    original.settle("private clean document");
    const pending = original.begin(expected)!; expect(pending).not.toBeNull();
    expect(ledger.forDraftOwner(scope, 7).read()).toBeNull();
    original.retire();
    const replacementScope = { ...scope, clinicalCaseId: 99 };
    const replacement = makeStudyOwner({ ...replacementScope, actorId: 7, recovery: ledger,
      authorized: () => true, writable: () => true, deny() {} });
    replacement.activate();
    expect(replacement.busy).toBe(true); expect(replacement.begin({ ...expected, scope: replacementScope })).toBeNull();
    pending.finish(); expect(replacement.busy).toBe(false);
    expect(replacement.document).toBe(""); expect(replacement.retryExpectation).toBeNull();
    expect(replacement.uncertain).toBe(true); expect(replacement.editable()).toBe(false);
    expect(replacement.begin({ ...expected, scope: replacementScope })).toBeNull();
    expect(replacement.beginRetry()).toBeNull();
    const returning = owner(ledger); expect(returning.document).toBe("private clean document");
    expect(returning.beginRetry()?.body).toBe(pending.body);
  });
  it("invalidates pre-refresh confirmation while keeping unknown write recovery bytes", async () => {
    const value = owner(), expected = expectation(), request = value.begin(expected)!;
    value.invalidateRead(); expect(await request.confirmResponse(saved(expected), 201)).toBe(false); request.finish();
    expect(value.uncertain).toBe(true); expect(value.retryExpectation).toEqual(expected);
  });
  it("denies new and late writes when current write capability is revoked", async () => {
    let writable = true;
    const value = makeStudyOwner({ ...scope, actorId: 7, recovery: makeStudyRecoveryLedger(), authorized: () => true, writable: () => writable, deny() {} }); value.activate();
    const expected = expectation(), request = value.begin(expected)!; writable = false;
    expect(await request.confirmResponse(saved(expected), 201)).toBe(false); request.finish();
    expect(value.active()).toBe(true); expect(value.editable()).toBe(false); expect(value.beginRetry()).toBeNull();
    expect(value.uncertain).toBe(true);
  });
  it("keeps malformed or wrong-owner success unresolved", async () => {
    const value = owner(), expected = expectation(), request = value.begin(expected)!;
    await expect(request.confirmResponse({ ...saved(expected), patientId: 99 }, 201)).rejects.toThrow("study_editor_scope_changed");
    request.finish(); expect(value.uncertain).toBe(true); expect(value.retryExpectation).toEqual(expected);
  });
});

it("blocks capacity overflow without evicting any unresolved command and leaves reads active", () => {
  const ledger = makeStudyRecoveryLedger();
  for (let index = 0; index < 16; index++) {
    const ownScope = { ...scope, orthoCaseId: 100 + index, clinicalCaseId: 200 + index };
    const value = makeStudyOwner({ ...ownScope, actorId: 7, recovery: ledger, authorized: () => true, writable: () => true, deny() {} }); value.activate();
    const expected = { ...expectation(), scope: ownScope };
    const request = value.begin(expected)!; expect(request).not.toBeNull(); request.markUncertain(); request.finish(); value.retire();
  }
  const blocked = owner(ledger); blocked.settle("readable existing draft");
  expect(blocked.begin(expectation())).toBeNull(); expect(blocked.submissionIssue).toBe("recovery_capacity");
  expect(blocked.active()).toBe(true); expect(blocked.document).toBe("readable existing draft");
  for (let index = 0; index < 16; index++) {
    const retained = ledger.forOwner({ ...scope, orthoCaseId: 100 + index, clinicalCaseId: 200 + index }, 7).read();
    expect(retained?.uncertain).toBe(true); expect(retained?.owned?.expected.command.clientRequestId).toBe("synthetic_study_command_001");
  }
});


it("quarantines a stable case after patient reassignment without retargeting its unresolved command", () => {
  const ledger = makeStudyRecoveryLedger(), original = owner(ledger), expected = expectation();
  original.change("unresolved original patient draft"); const request = original.begin(expected)!; const body = request.body;
  original.retire();
  const movedScope = { ...scope, patientId: 20 };
  const moved = makeStudyOwner({ ...movedScope, actorId: 7, recovery: ledger, authorized: () => true, writable: () => true, deny() {} }); moved.activate();
  expect(moved.document).toBe(""); expect(moved.busy).toBe(true); expect(moved.retryExpectation).toBeNull();
  expect(moved.begin({ ...expected, scope: movedScope })).toBeNull(); expect(moved.canRetry()).toBe(false);
  request.finish(); expect(moved.busy).toBe(false); expect(moved.uncertain).toBe(true);
  expect(moved.begin({ ...expected, scope: movedScope })).toBeNull();
  expect(ledger.forOwner(scope, 7).read()?.owned?.body).toBe(body);
  expect(ledger.forOwner(movedScope, 7).read()?.owned).toBeNull();
  expect(ledger.needsUnloadWarning()).toBe(true);
});


it("retains exact recovery when a documented success changes the canonical captured draft hash", async () => {
  const value = owner(), initial = expectation(), ref = { id: 91, contentHash: "a".repeat(64) };
  const expected: StudySaveExpectation = { ...initial, previousVersion: 1,
    command: { ...initial.command, kind: "documented", expectedHead: ref, documentedFrom: ref } };
  value.change("local documented intent"); const request = value.begin(expected)!; const bytes = request.body;
  const wrong = { ...saved(expected), revision: { ...saved(expected).revision, id: 92, version: 2, kind: "documented",
    predecessorId: 91, documentedFromId: 91, contentHash: "b".repeat(64) } };
  await expect(request.confirmResponse(wrong, 201)).rejects.toThrow("study_saved_command_mismatch");
  request.finish(); expect(value.uncertain).toBe(true); expect(value.document).toBe("local documented intent");
  expect(value.retryExpectation).toEqual(expected); expect(value.readVersion).toBe(0);
  const retry = value.beginRetry()!; expect(retry.body).toBe(bytes);
  expect(await retry.confirmResponse({ ...wrong, replayed: true, revision: { ...wrong.revision, contentHash: ref.contentHash } }, 200)).toBe(true);
  expect(await retry.confirmAcknowledgment(acknowledgment(expected))).toBe(true);
  retry.finish(); expect(value.uncertain).toBe(false); expect(value.readVersion).toBe(1);
});


it("does not settle recovery from an impossible self-referencing saved revision", async () => {
  const value = owner(), initial = expectation(), ref = { id: 91, contentHash: "a".repeat(64) };
  const expected: StudySaveExpectation = { ...initial, previousVersion: 1,
    command: { ...initial.command, kind: "documented", expectedHead: ref, documentedFrom: ref } };
  value.change("retained documentation intent"); const request = value.begin(expected)!;
  const malformed = { ...saved(expected), revision: { ...saved(expected).revision, id: 91, version: 2,
    kind: "documented", predecessorId: 91, documentedFromId: 91, contentHash: ref.contentHash } };
  await expect(request.confirmResponse(malformed, 201)).rejects.toThrow("invalid_study_editor_revision");
  request.finish(); expect(value.uncertain).toBe(true); expect(value.document).toBe("retained documentation intent");
  expect(value.retryExpectation).toEqual(expected); expect(value.readVersion).toBe(0);
});


it("notifies subscribers after current read authority is revoked so retained content is hidden", () => {
  let allowed = true, notifications = 0;
  const value = makeStudyOwner({ ...scope, actorId: 7, recovery: makeStudyRecoveryLedger(), authorized: () => allowed,
    writable: () => allowed, deny() { allowed = false; } }); value.activate(); value.settle("private retained local draft");
  const stop = value.subscribe(() => notifications++); value.denied();
  expect(notifications).toBe(1); expect(value.active()).toBe(false); expect(value.document).toBe(""); expect(value.editable()).toBe(false); stop();
});


it("fails closed on parent denial callback failure and preserves unresolved intent for a new authorized owner", () => {
  const recovery = makeStudyRecoveryLedger();
  const value = makeStudyOwner({ ...scope, actorId: 7, recovery, authorized: () => true, writable: () => true,
    deny() { throw new Error("synthetic callback failure"); } }); value.activate(); value.change("unresolved private intent");
  const expected = expectation(), request = value.begin(expected)!; let notified = 0; const stop = value.subscribe(() => notified++);
  expect(() => value.denied()).toThrow("synthetic callback failure"); expect(notified).toBeGreaterThan(0);
  expect(value.active()).toBe(false); expect(value.document).toBe(""); expect(value.beginRetry()).toBeNull();
  value.activate(); expect(value.active()).toBe(false);
  request.finish(); expect(recovery.needsUnloadWarning()).toBe(true); value.retire(); stop();
  const authorizedAgain = owner(recovery); expect(authorizedAgain.uncertain).toBe(true);
  expect(authorizedAgain.document).toBe("unresolved private intent"); expect(authorizedAgain.retryExpectation).toEqual(expected);
});

it("preserves a validated committed response when acknowledgment is lost", async () => {
  const value=owner(),expected=expectation(),request=value.begin(expected)!;
  expect(await request.confirmResponse(saved(expected),201)).toBe(true);request.finish();
  expect(value.uncertain).toBe(true);expect(value.retryExpectation).toEqual(expected);expect(value.readVersion).toBe(0);
});
it("rehydrates only the exact actor and scope without replacing conflicting unsent text", () => {
  const recovery=makeStudyRecoveryLedger(),value=owner(recovery),expected=expectation();
  expect(value.restore(expected)).toBe(true);expect(value.canRetry()).toBe(true);
  expect(value.retryExpectation).toEqual(expected);expect(value.document).toContain('Synthetic draft');
  expect(value.restore({...expected,actorId:8})).toBe(false);
  const other=owner();other.settle('saved');other.change('private newer local work');
  expect(other.restore(expected)).toBe(false);expect(other.document).toBe('private newer local work');
});
it("preserves recovered authored text as an unsaved draft after exact cancellation", () => {
  const recovery=makeStudyRecoveryLedger(),value=owner(recovery),expected=expectation();value.restore(expected);
  const before=value.document;expect(value.resolveCancelled('different_key_0001')).toBe(false);
  expect(value.resolveCancelled(expected.command.clientRequestId)).toBe(true);expect(value.uncertain).toBe(false);
  expect(value.document).toBe(before);expect(value.dirty).toBe(true);expect(recovery.needsUnloadWarning()).toBe(true);
});

describe('persistent source-authorization quarantine',()=>{
 it('keeps denied bytes hidden after cancellation acknowledgment and view remount until separately confirmed discard',()=>{
  const ledger=makeStudyRecoveryLedger(),first=owner(ledger),expected=expectation();
  first.change('PRIVATE_SOURCE_LOCAL_TEXT');const operation=first.begin(expected)!;operation.finish();
  first.quarantineDraft();expect(first.document).toBe('');expect(first.draftQuarantined).toBe(true);expect(first.canRetry()).toBe(true);
  expect(first.resolveCancelled(expected.command.clientRequestId)).toBe(true);expect(first.uncertain).toBe(false);
  expect(first.document).toBe('');expect(first.editable()).toBe(false);first.settle('source-free read');first.change('overwrite');
  first.retire();const second=owner(ledger);expect(second.draftQuarantined).toBe(true);expect(second.document).toBe('');expect(second.editable()).toBe(false);
  expect(second.canLeave(()=>true)).toBe(false);expect(second.discardQuarantinedDraft(()=>false)).toBe(false);
  expect(second.discardQuarantinedDraft(()=>true)).toBe(true);expect(second.draftQuarantined).toBe(false);expect(second.editable()).toBe(true);expect(second.dirty).toBe(false);
 });
 it('only reauthorizes the exact retained command and never discards an unresolved receipt',()=>{
  const value=owner(),expected=expectation();value.change('PRIVATE_SOURCE_TEXT');value.begin(expected)!.finish();value.quarantineDraft();
  expect(value.discardQuarantinedDraft(()=>true)).toBe(false);
  expect(value.restore({...expected,command:{...expected.command,reason:'Different'}})).toBe(false);expect(value.document).toBe('');
  expect(value.restore(expected)).toBe(true);expect(value.document).toBe('PRIVATE_SOURCE_TEXT');expect(value.canRetry()).toBe(true);
 });
});

it('invalidates an already pending response when a newer source quarantine arrives but allows a fresh hidden exact retry',async()=>{
 const value=owner(),expected=expectation();value.change('PRIVATE_LATE_TEXT');const pending=value.begin(expected)!;
 value.quarantineDraft();expect(await pending.confirmResponse(saved(expected),201)).toBe(false);pending.finish();expect(value.document).toBe('');expect(value.uncertain).toBe(true);
 const retry=value.beginRetry()!;expect(retry).not.toBeNull();expect(await retry.confirmResponse(saved(expected,true),200)).toBe(true);expect(await retry.confirmAcknowledgment(acknowledgment(expected))).toBe(true);retry.finish();
 expect(value.draftQuarantined).toBe(false);expect(value.uncertain).toBe(false);expect(value.document).toBe('');
});
