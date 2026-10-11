import { describe, expect, it, vi } from "vitest";
import { INTAKE_RECOVERY_MAX_ENTRIES, makeIntakeOwnerSlot, makeIntakeRecoveryLedger, type IntakeOwnerScope, type IntakeOwnerAccess } from "../lib/ortho-assessment-intake-owner";
import { readIntakeResponse } from "../lib/ortho-assessment-intake-client";
import { activateCommand, assessmentRead, emptyRead, eventFor, openCommand, saved } from "./ortho-assessment-intake-fixtures";
const scope = (): IntakeOwnerScope => ({ patientId: 7, principalId: 17, permissionKey: "synthetic_session_permission_1",
  selectedOrthoCaseId: null, selectedClinicalCaseId: null });
async function fixture(writable = true) {
  const state = { allowed: true, writable };
  const access: IntakeOwnerAccess = { authorized: () => state.allowed, writable: () => state.writable, deny: () => { state.allowed = false; } };
  const ledger = makeIntakeRecoveryLedger(), slot = makeIntakeOwnerSlot(ledger), owner = slot.select(scope(), access);
  const read = await readIntakeResponse({ ...emptyRead(), writable }, { patientId: 7 }); if (!read) throw new Error("fixture");
  expect(owner.lease().acceptRead(read)).toBe(true);
  return { state, access, ledger, slot, owner, read };
}
const explicitRefusal = { code: "open_case_exists", message: "Synthetic competing case" };
function pausedDigest() {
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, data) => { started(); await gate; return original(algorithm, data); });
  return { release, entered, restore: () => spy.mockRestore() };
}
describe("parent-owned intake leases and command lifetime", () => {
  it("fences retained reason/source/change/begin/discard callbacks with generation and exact document bytes", async () => {
    const f = await fixture(), a = f.owner.lease();
    expect(a.change('{"reason":"first","source":"new"}')).toBe(true);
    const b = f.owner.lease(); expect(b.change('{"reason":"second","source":"existing"}')).toBe(true);
    expect(a.change('{"reason":"stale"}')).toBe(false);
    expect(a.settle("stale")).toBe(false); expect(a.discard()).toBe(false); expect(a.begin({ command: openCommand(), read: f.read })).toBeNull();
    // Returning to identical bytes cannot revive the old source/reason callback.
    expect(f.owner.lease().change(a.document)).toBe(true);
    expect(a.current()).toBe(false); expect(a.change("late")).toBe(false);
    expect(b.discard()).toBe(false);
  });
  it("survives temporary view detach while A→B→A permanently retires every old callback", async () => {
    const f = await fixture(); f.owner.lease().change('{"reason":"authored"}');
    const retained = f.owner.lease();
    expect(f.slot.select(scope(), f.access)).toBe(f.owner); expect(f.owner.document).toBe('{"reason":"authored"}');
    const second = f.slot.select({ ...scope(), patientId: 70 }, f.access);
    expect(f.owner.retired).toBe(true); expect(retained.change("wrong patient")).toBe(false);
    const returned = f.slot.select(scope(), f.access);
    expect(returned).not.toBe(f.owner); expect(second.retired).toBe(true); expect(retained.current()).toBe(false);
    expect(returned.document).toBe("");
  });
  it("retains unresolved exact bytes across owner retirement and restores only to the same actor", async () => {
    const f = await fixture(); f.owner.lease().change('{"reason":"secret same-actor draft"}');
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    const body = request.body;
    f.slot.select({ ...scope(), patientId: 70 }, f.access);
    expect(f.owner.retired).toBe(true); expect(request.current()).toBe(false); request.finish();
    const other = f.slot.select({ ...scope(), principalId: 18 }, f.access);
    expect(other.recoveryBlocked).toBe(true); expect(other.document).toBe(""); expect(other.read).toBeNull();
    expect(other.confirmed).toBeNull(); expect(other.uncertain).toBe(false); expect(other.editable()).toBe(false);
    expect(other.lease().beginRetry()).toBeNull(); expect(other).not.toHaveProperty("body"); expect(other).not.toHaveProperty("command");
    const returned = f.slot.select(scope(), f.access);
    expect(returned).not.toBe(f.owner); expect(returned.uncertain).toBe(true);
    expect(returned.document).toBe('{"reason":"secret same-actor draft"}');
    const retry = returned.lease().beginRetry()!; expect(retry.body).toBe(body); expect(retry.command.commandId).toBe(openCommand().commandId);
    expect(await retry.confirmResponse(saved(await eventFor(), true), 200)).toBe(true); retry.finish();
    expect(returned.uncertain).toBe(false); expect(returned.document).toBe("");
    expect(f.slot.select({ ...scope(), principalId: 18 }, f.access).recoveryBlocked).toBe(false);
  });
  it("retains unresolved bytes even when the entire owner slot is replaced but the parent ledger survives", async () => {
    const f = await fixture(); f.owner.lease().change("authored");
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    f.slot.retire();
    const replacement = makeIntakeOwnerSlot(f.ledger).select(scope(), f.access);
    expect(replacement.uncertain).toBe(true); expect(replacement.lease().beginRetry()?.body).toBe(request.body);
    expect(request.current()).toBe(false);
  });
  it("blocks another selected case when an uncertain opening has no proven created IDs", async () => {
    const f = await fixture(); f.owner.lease().begin({ command: openCommand(), read: f.read });
    const selected = f.slot.select({ ...scope(), selectedOrthoCaseId: 8, selectedClinicalCaseId: 9 }, f.access);
    expect(selected.recoveryBlocked).toBe(true); expect(selected.lease().beginRetry()).toBeNull();
    expect(selected.editable()).toBe(false);
  });
  it("same-view parent reread invalidates callbacks and async confirmation without losing command bytes", async () => {
    const response = saved(await eventFor()), f = await fixture(); f.owner.lease().change("authored");
    const staleView = f.owner.lease(), request = staleView.begin({ command: openCommand(), read: f.read })!;
    const paused = pausedDigest();
    try {
      const confirmation = request.confirmResponse(response, 201); await paused.entered;
      f.owner.invalidateRead(); paused.release(); expect(await confirmation).toBe(false);
    } finally { paused.release(); paused.restore(); }
    expect(staleView.current()).toBe(false); expect(f.owner.busy).toBe(false); expect(f.owner.uncertain).toBe(true);
    request.finish(); expect(f.owner.document).toBe("authored");
    const currentGet = await readIntakeResponse(assessmentRead(response.event), { patientId: 7 });
    expect(f.owner.lease().acceptRead(currentGet!)).toBe(true); expect(f.owner.uncertain).toBe(true);
    expect(f.owner.lease().change("reconstructed")).toBe(false);
    const retry = f.owner.lease().beginRetry()!; expect(retry.body).toBe(request.body);
    expect(await retry.confirmResponse(saved(response.event, true), 200)).toBe(true); retry.finish();
    expect(f.owner.confirmed?.event.id).toBe(response.event.id); expect(f.owner.uncertain).toBe(false);
  });
  it("lost response retries preserve ID and bytes after current server state changes", async () => {
    const f = await fixture(); f.owner.lease().change("exact authored draft"); const command = openCommand();
    const request = f.owner.lease().begin({ command, read: f.read })!; const body = request.body;
    command.reason = "mutated caller object"; command.commandId = "new_wrong_command_123";
    request.markUncertain(); request.finish();
    const first = await eventFor(), activation = await eventFor(activateCommand());
    f.owner.invalidateRead();
    const changed = await readIntakeResponse({ ...assessmentRead(first), openCase: { orthoCaseId: 8, clinicalCaseId: 9, status: "active", lifecycleVersion: 2 }, history: [first, activation] }, { patientId: 7 });
    expect(f.owner.lease().acceptRead(changed!)).toBe(true);
    expect(f.owner.lease().begin({ command, read: changed! })).toBeNull();
    const retry = f.owner.lease().beginRetry()!; expect(retry.body).toBe(body); expect(JSON.parse(retry.body).commandId).toBe(openCommand().commandId);
    expect(Object.isFrozen(retry.command)).toBe(true);
    expect(await retry.confirmResponse(saved(first, true), 200)).toBe(true); retry.finish(); expect(f.owner.uncertain).toBe(false);
  });
  it("only a proved current initial refusal releases the command; retries and wrong refusals remain uncertain", async () => {
    const first = await fixture(); first.owner.lease().change("authored");
    const refused = first.owner.lease().begin({ command: openCommand(), read: first.read })!;
    expect(refused.refuse(explicitRefusal, 409)).toBe(true); refused.finish();
    expect(first.owner.uncertain).toBe(false); expect(first.owner.document).toBe("authored"); expect(first.owner.editable()).toBe(true);
    const second = await fixture(); second.owner.lease().change("authored");
    const uncertain = second.owner.lease().begin({ command: openCommand(), read: second.read })!;
    expect(uncertain.refuse({ ...explicitRefusal, code: "unknown_refusal" }, 409)).toBe(false);
    uncertain.finish(); expect(second.owner.uncertain).toBe(true);
    const retry = second.owner.lease().beginRetry()!;
    expect(retry.refuse(explicitRefusal, 409)).toBe(false); retry.finish(); expect(second.owner.uncertain).toBe(true);
    const third = await fixture(), stale = third.owner.lease().begin({ command: openCommand(), read: third.read })!;
    third.owner.invalidateRead(); expect(stale.refuse(explicitRefusal, 409)).toBe(false); stale.finish(); expect(third.owner.uncertain).toBe(true);
  });
  it.each([401, 403, 500, 503])("does not fabricate rollback for HTTP %s", async status => {
    const f = await fixture(); const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    request.checkHeaders({ status }); expect(request.refuse(explicitRefusal, status)).toBe(false); request.finish();
    if (status === 401 || status === 403) {
      expect(f.owner.retired).toBe(true); f.state.allowed = true;
      const recovered = f.slot.select({ ...scope(), permissionKey: "synthetic_reauthenticated_2" }, f.access);
      expect(recovered.uncertain).toBe(true); expect(recovered.lease().beginRetry()?.body).toBe(request.body);
    } else expect(f.owner.uncertain).toBe(true);
  });
  it("wrong scope/hash/command/response status never confirms or unlocks an uncertain command", async () => {
    const f = await fixture(); const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    const event = await eventFor();
    for (const invalid of [saved({ ...event, patientId: 70 }), saved({ ...event, contentHash: "0".repeat(64) }),
      saved(await eventFor({ ...openCommand(), commandId: "synthetic_wrong_command_1" })), assessmentRead(event)])
      expect(await request.confirmResponse(invalid, 201)).toBe(false);
    expect(await request.confirmResponse(saved(event), 200)).toBe(false); request.finish();
    expect(f.owner.uncertain).toBe(true); expect(f.owner.lease().discard()).toBe(false);
  });
  it("a permission revocation during digest cannot acknowledge the save or erase recovery", async () => {
    const f = await fixture(); const response = saved(await eventFor());
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!, paused = pausedDigest();
    try {
      const confirmation = request.confirmResponse(response, 201); await paused.entered;
      f.state.writable = false; paused.release(); expect(await confirmation).toBe(false);
    } finally { paused.release(); paused.restore(); }
    expect(f.owner.retired).toBe(true); request.finish();
    f.state.writable = true; const fresh = f.slot.select({ ...scope(), permissionKey: "synthetic_permission_2" }, f.access);
    expect(fresh.uncertain).toBe(true); expect(fresh.lease().beginRetry()?.body).toBe(request.body);
  });
  it("a principal/case change during digest permanently invalidates the old request", async () => {
    const f = await fixture(), response = saved(await eventFor());
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!, paused = pausedDigest();
    try {
      const confirmation = request.confirmResponse(response, 201); await paused.entered;
      const other = f.slot.select({ ...scope(), principalId: 18 }, f.access); expect(other.recoveryBlocked).toBe(true);
      paused.release(); expect(await confirmation).toBe(false);
    } finally { paused.release(); paused.restore(); }
    request.finish(); expect(f.owner.retired).toBe(true);
    const back = f.slot.select(scope(), f.access); expect(back.uncertain).toBe(true);
  });
  it("read-only scopes can read while every authored/write callback remains unavailable", async () => {
    const f = await fixture(false); expect(f.owner.authorized()).toBe(true); expect(f.owner.writable()).toBe(false); expect(f.owner.read).toBe(f.read);
    expect(f.owner.lease().change("forbidden")).toBe(false); expect(f.owner.lease().begin({ command: openCommand(), read: f.read })).toBeNull();
    expect(f.owner.lease().beginRetry()).toBeNull(); expect(f.owner.canLeave(() => false)).toBe(true);
    f.state.writable = true; expect(f.owner.writable()).toBe(false); expect(f.owner.retired).toBe(true);
    expect(f.slot.select({ ...scope(), permissionKey: "synthetic_new_capability" }, f.access).writable()).toBe(true);
  });
  it("notifies busy/uncertain/dirty/unload state and never uses discard permission to leave a pending write", async () => {
    const f = await fixture(), listener = vi.fn(), confirm = vi.fn(() => true); const unsubscribe = f.owner.subscribe(listener);
    expect(f.owner.needsUnloadWarning()).toBe(false); f.owner.lease().change("dirty"); expect(f.owner.dirty).toBe(true);
    expect(f.owner.needsUnloadWarning()).toBe(true); expect(f.owner.canLeave(confirm)).toBe(true); expect(confirm).toHaveBeenCalledTimes(1);
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    expect(f.owner.busy).toBe(true); expect(f.owner.canLeave(confirm)).toBe(false); expect(confirm).toHaveBeenCalledTimes(1);
    request.finish(); expect(f.owner.uncertain).toBe(true); expect(f.owner.canLeave(confirm)).toBe(false);
    expect(listener).toHaveBeenCalled(); unsubscribe();
  });
  it("keeps the parent ledger unload warning alive across unrelated patient navigation", async () => {
    const f = await fixture(), notify = vi.fn(); const unsubscribe = f.ledger.subscribe(notify);
    expect(f.ledger.needsUnloadWarning()).toBe(false);
    f.owner.lease().begin({ command: openCommand(), read: f.read });
    expect(f.ledger.needsUnloadWarning()).toBe(true); expect(notify).toHaveBeenCalledTimes(1);
    const otherPatient = f.slot.select({ ...scope(), patientId: 70 }, f.access);
    expect(otherPatient.uncertain).toBe(false); expect(otherPatient.needsUnloadWarning()).toBe(true);
    expect(f.ledger.needsUnloadWarning()).toBe(true); expect(Object.keys(f.ledger).sort()).toEqual(["needsUnloadWarning", "subscribe"]);
    const returned = f.slot.select(scope(), f.access), retry = returned.lease().beginRetry()!;
    expect(await retry.confirmResponse(saved(await eventFor(), true), 200)).toBe(true); retry.finish();
    expect(f.ledger.needsUnloadWarning()).toBe(false); expect(notify).toHaveBeenCalledTimes(2); unsubscribe();
  });
  it("requires explicit exact selected case/bridge for activation and preserves its predecessor on replay", async () => {
    const f = await fixture(), opening = await eventFor(), activation = await eventFor(activateCommand());
    const read = await readIntakeResponse(assessmentRead(opening), { patientId: 7, orthoCaseId: 8, clinicalCaseId: 9 });
    f.owner.lease().acceptRead(read!);
    expect(f.owner.lease().begin({ command: activateCommand(), read: read! })).toBeNull();
    const selectedScope = { ...scope(), selectedOrthoCaseId: 8, selectedClinicalCaseId: 9 };
    const selected = f.slot.select(selectedScope, f.access); expect(selected.lease().acceptRead(read!)).toBe(true);
    const request = selected.lease().begin({ command: activateCommand(), read: read! })!; request.finish();
    f.slot.select({ ...selectedScope, selectedClinicalCaseId: 99 }, f.access);
    const returned = f.slot.select(selectedScope, f.access), retry = returned.lease().beginRetry()!;
    expect(retry.body).toBe(request.body);
    expect(await retry.confirmResponse(saved({ ...activation, predecessorId: 999 }, true), 200)).toBe(false);
    expect(await retry.confirmResponse(saved(activation, true), 200)).toBe(true); retry.finish();
    expect(returned.uncertain).toBe(false);
  });
  it("refuses fresh commands at the finite ledger entry budget without evicting uncertain commands", async () => {
    const f = await fixture(); let firstBody = "";
    for (let i = 0; i < INTAKE_RECOVERY_MAX_ENTRIES; i++) {
      const patientId = 7 + i, owner = f.slot.select({ ...scope(), patientId }, f.access);
      const read = await readIntakeResponse({ ...emptyRead(), patientId }, { patientId });
      expect(owner.lease().acceptRead(read!)).toBe(true);
      const request = owner.lease().begin({ command: { ...openCommand(), patientId, commandId: `synthetic_budget_command_${i}` }, read: read! });
      expect(request).not.toBeNull(); if (i === 0) firstBody = request!.body; request!.finish();
    }
    const patientId = 7 + INTAKE_RECOVERY_MAX_ENTRIES, excess = f.slot.select({ ...scope(), patientId }, f.access);
    const read = await readIntakeResponse({ ...emptyRead(), patientId }, { patientId }); excess.lease().acceptRead(read!);
    expect(excess.lease().begin({ command: { ...openCommand(), patientId }, read: read! })).toBeNull();
    expect(excess.recoveryBlocked).toBe(true); expect(excess.uncertain).toBe(false);
    const restored = f.slot.select(scope(), f.access), retry = restored.lease().beginRetry();
    expect(retry?.body).toBe(firstBody); expect(f.ledger.needsUnloadWarning()).toBe(true);
  });
  it("enforces the serialized byte budget before reserving and does not evict large authored drafts", async () => {
    const f = await fixture(); let admitted = 0, firstBody = "";
    for (let i = 0; i < INTAKE_RECOVERY_MAX_ENTRIES; i++) {
      const patientId = 7 + i, owner = f.slot.select({ ...scope(), patientId }, f.access);
      const read = await readIntakeResponse({ ...emptyRead(), patientId }, { patientId }); owner.lease().acceptRead(read!);
      expect(owner.lease().settle(JSON.stringify({ note: "x".repeat(65_000) }))).toBe(true);
      const request = owner.lease().begin({ command: { ...openCommand(), patientId, commandId: `synthetic_byte_command_${i}` }, read: read! });
      if (!request) { expect(owner.busy).toBe(false); expect(owner.uncertain).toBe(false); break; }
      if (i === 0) firstBody = request.body; admitted++; request.finish();
    }
    expect(admitted).toBeGreaterThan(0); expect(admitted).toBeLessThan(INTAKE_RECOVERY_MAX_ENTRIES);
    const restored = f.slot.select(scope(), f.access);
    expect(restored.document).toBe(JSON.stringify({ note: "x".repeat(65_000) }));
    expect(restored.lease().beginRetry()?.body).toBe(firstBody);
  });
  it("digest failure keeps exact recovery rather than fabricating rollback", async () => {
    const f = await fixture(), response = saved(await eventFor());
    const request = f.owner.lease().begin({ command: openCommand(), read: f.read })!;
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("synthetic unavailable digest"));
    try { expect(await request.confirmResponse(response, 201)).toBe(false); } finally { digest.mockRestore(); }
    request.finish(); expect(f.owner.uncertain).toBe(true);
    expect(f.owner.lease().beginRetry()?.body).toBe(request.body);
  });
  it("quarantines an unresolved stable case/bridge pair after a canonical patient change", async () => {
    const f = await fixture(), opening = await eventFor(), selectedScope = { ...scope(), selectedOrthoCaseId: 8, selectedClinicalCaseId: 9 };
    const read = await readIntakeResponse(assessmentRead(opening), { patientId: 7, orthoCaseId: 8, clinicalCaseId: 9 });
    const original = f.slot.select(selectedScope, f.access); original.lease().acceptRead(read!);
    const request = original.lease().begin({ command: activateCommand(), read: read! })!; request.finish();
    const merged = f.slot.select({ ...selectedScope, patientId: 70 }, f.access);
    expect(merged.recoveryBlocked).toBe(true); expect(merged.document).toBe(""); expect(merged.uncertain).toBe(false);
    const movedRead = await readIntakeResponse({ ...assessmentRead({ ...opening, patientId: 70 }), patientId: 70 }, { patientId: 70, orthoCaseId: 8, clinicalCaseId: 9 });
    expect(merged.lease().acceptRead(movedRead!)).toBe(true);
    expect(merged.lease().begin({ command: { ...activateCommand(), patientId: 70 }, read: movedRead! })).toBeNull();
    expect(merged.lease().beginRetry()).toBeNull(); expect(f.ledger.needsUnloadWarning()).toBe(true);
    // No implicit canonical handoff: original patient, actor and exact body remain retained.
    const restored = f.slot.select(selectedScope, f.access);
    expect(restored.lease().beginRetry()?.body).toBe(request.body);
    expect(JSON.parse(request.body).patientId).toBe(7);
  });
  it("a stale async read cannot overwrite a newer draft or satisfy begin", async () => {
    const f = await fixture(), stale = f.owner.lease(); f.owner.lease().change("newer");
    const read = await readIntakeResponse(emptyRead(), { patientId: 7 });
    expect(stale.acceptRead(read!)).toBe(false);
    expect(f.owner.lease().begin({ command: openCommand(), read: read! })).toBeNull();
    expect(f.owner.document).toBe("newer");
  });
});
