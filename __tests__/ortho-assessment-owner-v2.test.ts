import { describe, expect, it } from "vitest";
import { makeAssessmentOwnerV2 } from "../lib/ortho-assessment-owner-v2";
import { createPersistedAssessmentV2, assessmentJsonHash } from "../lib/ortho-assessment-persisted-v2";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { readAssessmentResponseV2 } from "../lib/ortho-assessment-client-v2";
import { newAssessmentEditorV2, readAssessmentEditorV2, assessmentEditorCommandV2 } from "../lib/ortho-assessment-editor-v2";
function fixture() {
  let allowed = true;
  const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 }, command = assessmentCommandV2();
  const owner = makeAssessmentOwnerV2({ ...scope, authorized: () => allowed, deny: () => { allowed = false; } });
  owner.activate(); owner.settle("initial"); owner.change("draft");
  const persisted = createPersistedAssessmentV2(command.content); if (!persisted.ok) throw Error(persisted.code);
  const revision = { ...scope, schemaVersion: 2 as const, id: 4, version: 1, supersedesRevisionId: null, recordedPatientId: 1,
    recordingContext: "current" as const, createdBy: "Synthetic recorder", createdAt: "2026-01-01T00:00:00.000Z", reason: command.reason,
    content: persisted.value, contentHash: assessmentJsonHash(persisted.value) };
  const expected = { scope, command, previousVersion: 0 };
  return { owner, expected, revision, revoke: () => { allowed = false; }, grant: () => { allowed = true; } };
}
describe("schema2 exact-command parent lifetime", () => {
  it("blocks pending/uncertain leave, freezes exact bytes and clears only its confirmed replay", async () => {
    const f = fixture(), lease = f.owner.begin(f.expected)!;
    expect(lease.body).toBe(JSON.stringify(f.expected.command)); expect(f.owner.canLeave(() => true)).toBe(false);
    lease.markUncertain(); lease.finish(); f.owner.settle("");
    expect(f.owner.document).toBe("draft"); expect(f.owner.uncertain).toBe(true);
    expect(f.owner.beginRetry({ ...f.expected, command: { ...f.expected.command, reason: "different" } })).toBeNull();
    expect(f.owner.beginRetry({ ...f.expected, previousVersion: 1 })).toBeNull();
    const retry = f.owner.beginRetry(f.expected)!;
    expect(retry.body).toBe(lease.body);
    expect(await retry.confirmResponse({ ok: true, revision: f.revision, replayed: true }, 200)).toBe(true);
    retry.finish(); expect(f.owner.document).toBe(""); expect(f.owner.uncertain).toBe(false); expect(f.owner.readVersion).toBe(1);
  });
  it("never clears an uncertain first attempt from a retry refusal or a generic GET", async () => {
    const f = fixture(), first = f.owner.begin(f.expected)!; first.markUncertain(); first.finish();
    const retry = f.owner.beginRetry(f.expected)!; retry.refuse(409);
    expect(await retry.confirmResponse({ ok: true, revision: f.revision }, 200)).toBe(false);
    retry.finish(); expect(f.owner.uncertain).toBe(true); expect(f.owner.canLeave(() => true)).toBe(false);
  });
  it("rechecks permission after asynchronous verification and keeps an old owner retired after A→B→A", async () => {
    const f = fixture(), lease = f.owner.begin(f.expected)!;
    const pending = lease.confirmResponse({ ok: true, revision: f.revision, replayed: false }, 201);
    f.revoke(); expect(await pending).toBe(false); lease.finish(); expect(f.owner.uncertain).toBe(true);
    f.owner.retire(); f.grant(); expect(lease.current()).toBe(false);
    expect(await lease.confirmResponse({ ok: true, revision: f.revision, replayed: false }, 201)).toBe(false);
    const fresh = fixture(); expect(fresh.owner.document).toBe("draft"); expect(fresh.owner.uncertain).toBe(false);
  });
  it("rejects wrong predecessor/version/content/status and retains raw draft on a definitive initial refusal", async () => {
    const f = fixture(), lease = f.owner.begin(f.expected)!;
    expect(await lease.confirmResponse({ ok: true, revision: { ...f.revision, version: 2 }, replayed: false }, 201)).toBe(false);
    expect(await lease.confirmResponse({ ok: true, revision: f.revision, replayed: false }, 200)).toBe(false);
    lease.refuse(409); lease.finish(); expect(f.owner.document).toBe("draft"); expect(f.owner.uncertain).toBe(false);
  });
});
it("verifies full read scope/history and rejects restricted-image contradictions", async () => {
  const f = fixture(); const r = f.revision; const entry = { schemaVersion: r.schemaVersion, id: r.id, version: r.version, supersedesRevisionId: r.supersedesRevisionId, recordedPatientId: r.recordedPatientId, recordingContext: r.recordingContext, createdBy: r.createdBy, createdAt: r.createdAt, reason: r.reason };
  const raw = { ok: true, representation: 2, state: "ready", ...f.expected.scope, recordingContext: "current", clinicalWritable: true,
    revision: f.revision, history: [entry], sources: { items: [], truncated: false, imaging: "allowed" }, sourceStates: [] };
  expect(await readAssessmentResponseV2(raw, f.expected.scope)).not.toBeNull();
  expect(await readAssessmentResponseV2({ ...raw, patientId: 10 }, f.expected.scope)).toBeNull();
  expect(await readAssessmentResponseV2({ ...raw, history: [] }, f.expected.scope)).toBeNull();
  const document = { kind: "document", id: 22, version: "sha256:" + "a".repeat(64) };
  expect(await readAssessmentResponseV2({ ...raw, sources: { items: [{ ...document, label: "Synthetic" }], truncated: false, imaging: "restricted" } }, f.expected.scope)).toBeNull();
  expect(await readAssessmentResponseV2({ ...raw, sourceStates: [{ source: document, state: "available" }] }, f.expected.scope)).toBeNull();
});
it("round-trips incomplete raw editor text without turning it into a zero or saved result", () => {
  const f = fixture(), draft = newAssessmentEditorV2("synthetic-editor-command", f.revision)!;
  const id = draft.measurements.payload.observations.observations.find(row => row.definition === "mesiodistal_width")!.id;
  draft.measurements.values[id].numberText = "7.";
  const reopened = readAssessmentEditorV2(JSON.stringify(draft));
  expect(reopened?.measurements.values[id].numberText).toBe("7."); expect(reopened && assessmentEditorCommandV2(reopened)).toBeNull();
});
it("discards a digest completion from an old case lifetime without settling the replacement owner", async () => {
  const old = fixture(), lease = old.owner.begin(old.expected)!;
  const verification = lease.confirmResponse({ ok: true, revision: old.revision, replayed: false }, 201);
  old.owner.retire();
  const replacement = makeAssessmentOwnerV2({ patientId: 1, orthoCaseId: 9, clinicalCaseId: 10, authorized: () => true, deny: () => undefined });
  replacement.activate(); replacement.settle("new case");
  expect(await verification).toBe(false); lease.finish();
  expect(replacement.document).toBe("new case"); expect(replacement.readVersion).toBe(0); expect(replacement.uncertain).toBe(false);
});

// A parent refresh can temporarily unmount the view, but never acknowledges an old operation.
it("fences parent read A→loading→A while retaining the same exact retry command", async () => {
  const f = fixture(), first = f.owner.begin(f.expected)!;
  const confirmation = first.confirmResponse({ ok: true, revision: f.revision, replayed: false }, 201);
  f.owner.invalidateRead();
  expect(await confirmation).toBe(false); expect(first.current()).toBe(false);
  first.finish();
  expect(f.owner.document).toBe("draft"); expect(f.owner.uncertain).toBe(true);
  expect(f.owner.canLeave(() => true)).toBe(false);
  const retry = f.owner.beginRetry(f.expected)!;
  expect(retry.body).toBe(first.body);
  expect(await retry.confirmResponse({ ok: true, revision: f.revision, replayed: true }, 200)).toBe(true);
  retry.finish(); expect(f.owner.uncertain).toBe(false); expect(f.owner.document).toBe("");
});
it("preserves an idle draft across a parent reread and keeps changed retries refused", () => {
  const f = fixture(); f.owner.invalidateRead(); expect(f.owner.document).toBe("draft");
  expect(f.owner.dirty).toBe(true); expect(f.owner.editable()).toBe(true);
  const first = f.owner.begin(f.expected)!; first.markUncertain(); first.finish(); f.owner.invalidateRead();
  expect(f.owner.beginRetry({ ...f.expected, command: { ...f.expected.command, reason: "replacement" } })).toBeNull();
  expect(f.owner.document).toBe("draft"); expect(f.owner.uncertain).toBe(true);
});
