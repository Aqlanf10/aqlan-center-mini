import { describe, expect, it } from "vitest";
import { decodeStudySavedContent, type StudySavedContent } from "../lib/ortho-case-study-capture";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
const scope = { patientId: 10, orthoCaseId: 20, clinicalCaseId: 30 };
function captured(): StudySavedContent {
  const payload = { id: 40, version: 1, createdAt: "2026-10-11T00:00:00.000Z", createdBy: "Synthetic clinician", content: { dental: "Explicit recorded fact", note: null } };
  const selection = { key: "diagnosis1", kind: "diagnosis" as const, id: 40, version: 1, contentHash: journeyContentHash(payload.content) };
  return { schemaVersion: 1, capturedAt: "2026-10-11T00:01:00.000Z", recordedPatientId: 10, orthoCaseId: 20, clinicalCaseId: 30, caseStatusAtCapture: "active",
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: "b".repeat(64) }, identityDisclosure: "case_only",
      sources: [selection], groups: [], panels: [{ instanceId: "interview1", layoutKey: "interview", included: true, state: "available",
        sourceKeys: [selection.key], images: [], comment: "Explicit author comment" }], mediaUses: [], comment: "" },
    sources: [{ selection, state: "available", unavailableReason: null, access: { images: false, plans: false }, payload }] };
}
describe("strict stored study capture", () => {
  it("preserves explicit source facts and immutable original provenance across a canonical patient merge", () => {
    const value = captured(), before = JSON.stringify(value);
    expect(decodeStudySavedContent(value, scope)).toEqual({ ok: true, value });
    expect(decodeStudySavedContent(value, { ...scope, patientId: 11 })).toEqual({ ok: true, value });
    expect(JSON.stringify(value)).toBe(before);
    expect(decodeStudySavedContent(value, { ...scope, orthoCaseId: 21 }).ok).toBe(false);
    expect(decodeStudySavedContent(value, { ...scope, clinicalCaseId: 31 }).ok).toBe(false);
  });
  it("rejects missing tails, substituted source keys and mismatched content hashes", () => {
    const value = captured(); value.sources = [];
    expect(decodeStudySavedContent(value, scope).ok).toBe(false);
    const changed = captured(); changed.sources[0].selection = { ...changed.sources[0].selection, key: "other" };
    expect(decodeStudySavedContent(changed, scope).ok).toBe(false);
    const tampered = captured(); Object.assign(tampered.sources[0].payload as object, { content: { dental: "Substituted" } });
    expect(decodeStudySavedContent(tampered, scope).ok).toBe(false);
  });
  it("rejects coercible enums and hidden financial or provenance fields", () => {
    const value = captured();
    expect(decodeStudySavedContent({ ...value, caseStatusAtCapture: ["active"] }, scope).ok).toBe(false);
    expect(decodeStudySavedContent({ ...value, sources: [{ ...value.sources[0], state: ["available"] }] }, scope).ok).toBe(false);
    expect(decodeStudySavedContent({ ...value, sources: [{ ...value.sources[0], access: { images: "false", plans: false } }] }, scope).ok).toBe(false);
    const extra = captured(); Object.assign(extra.sources[0].payload as object, { balance: 1000 });
    expect(decodeStudySavedContent(extra, scope).ok).toBe(false);
  });
  it("retains unavailable source identity without pretending it contains captured facts", () => {
    const value = captured(); value.sources[0] = { ...value.sources[0], state: "unavailable", unavailableReason: "source_missing_or_outside_case", payload: null };
    expect(decodeStudySavedContent(value, scope)).toEqual({ ok: true, value });
    value.sources[0].payload = { dental: "Normal" };
    expect(decodeStudySavedContent(value, scope).ok).toBe(false);
  });
  it("refuses a source-specific unavailability reason attached to an unrelated kind", () => {
    const value = captured(); value.sources[0] = { ...value.sources[0], state: "unavailable", unavailableReason: "document_removed", payload: null };
    expect(decodeStudySavedContent(value, scope).ok).toBe(false);
  });
});
