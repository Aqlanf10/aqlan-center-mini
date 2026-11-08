import { describe, expect, it } from "vitest";
import { makeStudyRecoveryLedger } from "../lib/ortho-case-study-recovery";
import { makeStudyOwner } from "../lib/ortho-case-study-owner";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
describe("bounded unsubmitted study recovery", () => {
  it("keeps exact private bytes bound to actor, current patient and bridge without exposing an inventory", () => {
    const ledger = makeStudyRecoveryLedger(), own = ledger.forDraftOwner(scope, 7);
    const token = own.write(null, "private comment", "saved")!; expect(token).not.toBeNull();
    expect(ledger.needsUnloadWarning()).toBe(true);
    for (const handle of [ledger.forDraftOwner(scope, 8), ledger.forDraftOwner({ ...scope, patientId: 20 }, 7), ledger.forDraftOwner({ ...scope, clinicalCaseId: 52 }, 7)]) {
      expect(handle.read()).toEqual({ foreign: true, owned: null });
      expect(handle.write(null, "replacement", "")).toBeNull(); expect(handle.discard(token)).toBe(false);
    }
    expect(own.read()?.owned?.document).toBe("private comment");
    expect(own.discard(token)).toBe(true); expect(ledger.needsUnloadWarning()).toBe(false);
  });
  it("uses exact token CAS so a stale owner cannot replace or discard newer edits", () => {
    const ledger = makeStudyRecoveryLedger(), a = ledger.forDraftOwner(scope, 7), b = ledger.forDraftOwner(scope, 7);
    const first = a.write(null, "one", "saved")!, next = b.write(first, "two", "saved")!;
    expect(a.write(first, "stale", "saved")).toBeNull(); expect(a.discard(first)).toBe(false);
    expect(b.read()?.owned?.document).toBe("two"); expect(b.discard(next)).toBe(true);
  });
  it("refuses a seventeenth case without evicting any unresolved edit", () => {
    const ledger = makeStudyRecoveryLedger();
    for (let n = 1; n <= 16; n++) expect(ledger.forDraftOwner({ ...scope, orthoCaseId: n }, 7).write(null, `draft-${n}`, "")).not.toBeNull();
    expect(ledger.forDraftOwner({ ...scope, orthoCaseId: 17 }, 7).write(null, "new", "")).toBeNull();
    for (let n = 1; n <= 16; n++) expect(ledger.forDraftOwner({ ...scope, orthoCaseId: n }, 7).read()?.owned?.document).toBe(`draft-${n}`);
  });
  it("refuses per-value encoded bytes and aggregate capacity before accepting a replacement", () => {
    const ledger = makeStudyRecoveryLedger(), value = "x".repeat(2 * 1024 * 1024);
    const own = ledger.forDraftOwner(scope, 7), prior = own.write(null, "retained", "saved")!;
    expect(own.write(prior, "أ".repeat(1024 * 1024 + 1), "saved")).toBeNull();
    expect(own.read()?.owned?.document).toBe("retained");
    for (let n = 1; n <= 7; n++) expect(ledger.forDraftOwner({ ...scope, orthoCaseId: n }, 7).write(null, value, "")).not.toBeNull();
    expect(ledger.forDraftOwner({ ...scope, orthoCaseId: 8 }, 7).write(null, value, "")).toBeNull();
    expect(own.read()?.owned?.document).toBe("retained");
  });
  it("owner capacity refusal preserves old document and retirement preserves the registered draft", () => {
    const recovery = makeStudyRecoveryLedger();
    const owner = makeStudyOwner({ ...scope, actorId: 7, recovery, authorized: () => true, writable: () => true, deny() {} });
    owner.activate(); owner.settle("saved"); owner.change("retained");
    expect(() => owner.change("x".repeat(2 * 1024 * 1024 + 1))).toThrow("study_draft_capacity_or_conflict");
    expect(owner.document).toBe("retained"); owner.retire(); expect(owner.document).toBe("");
    expect(recovery.forDraftOwner(scope, 7).read()?.owned?.document).toBe("retained");
  });
});
