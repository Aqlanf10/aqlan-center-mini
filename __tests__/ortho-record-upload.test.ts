import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeRecordUploadOwner } from "../lib/ortho-record-upload-owner";
import { readRecordUploadCommand, verifyRecordUploadReceipt, type RecordUploadCommand } from "../lib/ortho-record-upload";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
const file = () => new File(["synthetic image bytes"], "synthetic.png", { type: "image/png" });
const command = (image = file()): RecordUploadCommand => ({ schemaVersion: 1, clientRequestId: randomUUID(), title: "Synthetic face", photoView: "extraoral_frontal", photoStage: null,
  occurrence: { state: "unknown", takenOn: null, sourceNote: "Synthetic historical source; date unknown" }, file: { sha256: "a".repeat(64), sizeBytes: image.size, mimeType: "image/png" } });
const receipt = (cmd: RecordUploadCommand, replayed = false) => ({ ok: true as const, patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, documentId: 4, actorId: 5, commandId: cmd.clientRequestId,
  requestFingerprint: createHash("sha256").update(canonicalJourneyJSON(cmd)).digest("hex"), replayed });
function setup() {
  let allowed = true, writable = true;
  const owner = makeRecordUploadOwner({ patientId: 1, orthoCaseId: 2, actorId: 5, authorized: () => allowed, writable: () => writable, deny: () => { allowed = false; } });
  owner.activate(); const image = file(), cmd = command(image);
  owner.select(image, cmd.photoView, cmd.title); owner.update({ stage: "unknown", dateState: "unknown", sourceNote: cmd.occurrence.sourceNote });
  return { owner, cmd, deny: () => { allowed = false; }, readonly: () => { writable = false; } };
}
describe("explicit original-image upload provenance", () => {
  it("keeps unknown facts null and refuses inferred or contradictory dates, stages and payloads", () => {
    const cmd = command(); expect(readRecordUploadCommand(cmd)).toEqual(cmd);
    for (const invalid of [{ ...cmd, photoStage: "archived" }, { ...cmd, unexpected: true }, { ...cmd, occurrence: { ...cmd.occurrence, takenOn: "2026-01-01" } },
      { ...cmd, occurrence: { ...cmd.occurrence, state: "known", takenOn: "2026-02-30" } }, { ...cmd, file: { ...cmd.file, sizeBytes: 0 } }, { ...cmd, occurrence: { ...cmd.occurrence, sourceNote: " " } }]) expect(() => readRecordUploadCommand(invalid)).toThrow();
  });
  it("checks receipt actor, case, bytes fingerprint and HTTP replay status", async () => {
    const cmd = command(), expected = { patientId: 1, orthoCaseId: 2, actorId: 5, command: cmd }, valid = receipt(cmd);
    await expect(verifyRecordUploadReceipt(valid, expected, 201)).resolves.toEqual(valid);
    for (const invalid of [{ ...valid, actorId: 9 }, { ...valid, orthoCaseId: 9 }, { ...valid, requestFingerprint: "b".repeat(64) }, { ...valid, replayed: true }]) await expect(verifyRecordUploadReceipt(invalid, expected, 201)).rejects.toThrow();
    await expect(verifyRecordUploadReceipt(valid, expected, 200)).rejects.toThrow();
  });
  it("freezes the actual file and command across uncertain writes and confirms the same retry only", async () => {
    const { owner, cmd } = setup(), original = owner.draft!, first = owner.begin(cmd)!;
    expect(first.form().get("file")).toBe(original.file); first.markUncertain(); first.finish();
    owner.update({ title: "must not replace" }); expect(owner.draft).toBe(original); expect(owner.discard()).toBe(false); expect(owner.canLeave(() => true)).toBe(false);
    const retry = owner.beginRetry()!; expect(retry.form().get("command")).toBe(first.form().get("command")); expect(retry.form().get("file")).toBe(original.file);
    await retry.confirm(receipt(cmd, true), 200); retry.finish(); expect(owner.draft).toBe(null); expect(owner.lastDocumentId).toBe(4); expect(owner.canLeave(() => false)).toBe(true);
  });
  it("does not settle a late acknowledgement after a parent read or permission withdrawal", async () => {
    const one = setup(), lease = one.owner.begin(one.cmd)!; one.owner.invalidateRead();
    expect(lease.signal.aborted).toBe(true); expect(await lease.confirm(receipt(one.cmd), 201)).toBe(null); lease.finish(); expect(one.owner.uncertain).toBe(true); expect(one.owner.draft).not.toBe(null);
    const two = setup(), revoked = two.owner.begin(two.cmd)!; two.readonly(); expect(await revoked.confirm(receipt(two.cmd), 201)).toBe(null); revoked.finish(); expect(two.owner.uncertain).toBe(true);
    one.owner.retire(); expect(one.owner.draft).toBe(null); expect(one.owner.pendingCommand).toBe(null);
  });
  it("keeps an uncertain replay after rejection but permits correction of an initially refused command", () => {
    const one = setup(), lease = one.owner.begin(one.cmd)!; lease.refuse(400); lease.finish(); expect(one.owner.editable()).toBe(true); expect(one.owner.draft).not.toBe(null);
    const two = setup(), sent = two.owner.begin(two.cmd)!; sent.markUncertain(); sent.finish(); const retry = two.owner.beginRetry()!; retry.refuse(409); retry.finish(); expect(two.owner.uncertain).toBe(true); expect(two.owner.pendingCommand).toEqual(two.cmd);
  });
  it("revokes the parent immediately on access denial and rejects a stale command before upload", () => {
    const { owner, cmd } = setup(); expect(owner.begin({ ...cmd, title: "wrong draft" })).toBe(null); const lease = owner.begin(cmd)!;
    expect(lease.checkHeaders(new Response("", { status: 403 }))).toBe(false); expect(owner.active()).toBe(false); lease.finish(); expect(owner.uncertain).toBe(true);
  });
});
