import { describe, expect, it } from "vitest";
import { verifyStudyEditorRead } from "../lib/ortho-case-study-editor-response";
import { readStudyEditorRead, readStudyEditorSaved } from "../lib/ortho-case-study-editor-contract";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function fixture() {
  const template = { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: journeyContentHash(CASE_TEMPLATE_IDENTITY) };
  const authored = { template, identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "Synthetic authored note",
    panels: [{ instanceId: "cover1", layoutKey: "cover", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "" }] };
  const metadata = { id: 91, version: 1, kind: "draft", contentHash: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z",
    predecessorId: null, documentedFromId: null, baseDocumentedId: null };
  const revision = { ...scope, ...metadata, actorId: 7, reason: "Synthetic study draft", authoredHash: journeyContentHash(authored), authored };
  return { ok: true, ...scope, template, revision, history: [metadata], head: { id: 91, contentHash: metadata.contentHash }, canAppend: true };
}
describe("strict saved-study editor projection", () => {
  it("accepts the exact authored projection and preserves independent canonical hash", () => {
    const input = fixture(), bytes = JSON.stringify(input);
    expect(readStudyEditorRead(input, scope)).toEqual(input); expect(JSON.stringify(input)).toBe(bytes);
    expect(readStudyEditorSaved({ ok: true, ...scope, replayed: false, revision: input.revision }, scope).revision).toEqual(input.revision);
  });
  it.each([null, "7", 0, -1, [7], Number.MAX_SAFE_INTEGER + 1].map(actorId => ({ actorId })))("rejects an invalid actor identity $actorId", ({ actorId }) => {
    const input = fixture(); expect(() => readStudyEditorRead({ ...input, revision: { ...input.revision, actorId } }, scope)).toThrow();
  });
  it("rejects foreign scope, hidden clinical capture and unknown envelope fields", () => {
    const input = fixture();
    expect(() => readStudyEditorRead({ ...input, patientId: 20 }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...input, revision: { ...input.revision, content: { clinical: "unrequested" } } }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...input, extra: true }, scope)).toThrow();
  });
  it("requires primitive booleans and literal revision kinds", () => {
    const input = fixture();
    expect(() => readStudyEditorRead({ ...input, canAppend: [true] }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...input, revision: { ...input.revision, kind: ["draft"] } }, scope)).toThrow();
    expect(() => readStudyEditorSaved({ ok: true, ...scope, replayed: "false", revision: input.revision }, scope)).toThrow();
  });
  it("rejects mismatched selected metadata and a head absent from complete history", () => {
    const input = fixture();
    expect(() => readStudyEditorRead({ ...input, revision: { ...input.revision, createdAt: "2026-10-02T00:00:00.000Z" } }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...input, head: { id: 92, contentHash: "a".repeat(64) } }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...input, revision: null }, scope)).toThrow();
  });
  it("requires documentation to copy the preceding draft hash and base", () => {
    const input = fixture(), first = input.history[0];
    const documented = { ...first, id: 92, version: 2, kind: "documented", predecessorId: 91, documentedFromId: 91 };
    const valid = { ...input, history: [first, documented], head: { id: 92, contentHash: first.contentHash }, revision: { ...input.revision, ...documented } };
    expect(readStudyEditorRead(valid, scope).revision?.kind).toBe("documented");
    expect(() => readStudyEditorRead({ ...valid, history: [first, { ...documented, contentHash: "b".repeat(64) }] }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...valid, history: [first, { ...documented, baseDocumentedId: 91 }] }, scope)).toThrow();
    expect(() => readStudyEditorRead({ ...valid, history: [first, { ...documented, documentedFromId: 999 }] }, scope)).toThrow();
  });
});


it("binds latest-mode read to the exact head while preserving explicit historical selection", async () => {
  const input = fixture(), first = input.history[0];
  const next = { ...first, id: 92, version: 2, predecessorId: first.id, contentHash: "b".repeat(64) };
  const staleLatest = { ...input, history: [first, next], head: { id: next.id, contentHash: next.contentHash } };
  await expect(verifyStudyEditorRead(staleLatest, scope)).rejects.toThrow("study_editor_requested_revision_mismatch");
  expect((await verifyStudyEditorRead(staleLatest, scope, first.id)).revision?.id).toBe(first.id);
  await expect(verifyStudyEditorRead(staleLatest, scope, next.id)).rejects.toThrow("study_editor_requested_revision_mismatch");
  const latest = { ...staleLatest, revision: { ...input.revision, ...next } };
  expect((await verifyStudyEditorRead(latest, scope)).revision?.id).toBe(next.id);
});
