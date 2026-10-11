import { describe, expect, it } from "vitest";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { assessmentJsonHash, createPersistedAssessmentV2, type AssessmentRevisionV2 } from "../lib/ortho-assessment-persisted-v2";
import { readAssessmentResponseV2 } from "../lib/ortho-assessment-client-v2";
import type { AssessmentHistoryEntryV2, AssessmentReadResponseV2, AssessmentSourceStateV2 } from "../lib/ortho-assessment-response-v2";
import type { AssessmentSourceV2 } from "../lib/ortho-assessment-v2";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
function revision(id: number, version: number, previous: number | null, sources: AssessmentSourceV2[] = []): AssessmentRevisionV2 {
  const command = assessmentCommandV2(); command.content.observations.observations[0].provenance!.sources = sources;
  const content = createPersistedAssessmentV2(command.content); if (!content.ok) throw Error(content.code);
  return { ...scope, schemaVersion: 2, id, version, supersedesRevisionId: previous, recordedPatientId: 1,
    recordingContext: "current", createdBy: "Synthetic examiner", createdAt: "2026-01-01T00:00:00.000Z", reason: command.reason,
    content: content.value, contentHash: assessmentJsonHash(content.value) };
}
const reference = (r: AssessmentRevisionV2): AssessmentSourceV2 => ({ kind: "assessment_revision", id: r.id, version: `sha256:${r.contentHash}` });
function entry(r: AssessmentRevisionV2): AssessmentHistoryEntryV2 {
  return { schemaVersion: r.schemaVersion, id: r.id, version: r.version, supersedesRevisionId: r.supersedesRevisionId,
    recordedPatientId: r.recordedPatientId, recordingContext: r.recordingContext, createdBy: r.createdBy, createdAt: r.createdAt, reason: r.reason };
}
function chain() {
  const document: AssessmentSourceV2 = { kind: "document", id: 90, version: "sha256:" + "a".repeat(64) };
  const a = revision(40, 1, null, [document]), b = revision(20, 2, a.id, [reference(a)]), c = revision(60, 3, b.id, [reference(b)]);
  const states: AssessmentSourceStateV2[] = [b, a].map(r => ({ source: reference(r), state: "available" }));
  states.push({ source: document, state: "changed" });
  const response: AssessmentReadResponseV2 = { ok: true, representation: 2, state: "ready", ...scope, recordingContext: "current", clinicalWritable: true,
    revision: c, history: [c, b, a].map(entry), sources: { items: [], truncated: false, imaging: "allowed" }, sourceStates: states };
  return { a, b, c, document, response };
}
describe("assessment browser transitive source envelope", () => {
  it("reopens a real hash-verified C→B→A payload and keeps external freshness distinct", async () => {
    const f = chain(), read = await readAssessmentResponseV2(f.response, scope);
    expect(read?.revision?.id).toBe(f.c.id); expect(read?.sourceStates).toEqual(f.response.sourceStates);
    expect(read?.sourceStates[2].state).toBe("changed");
  });
  it("still requires every exact direct hash and rejects duplicate identities", async () => {
    const f = chain();
    for (const states of [f.response.sourceStates.slice(1),
      [{ source: { ...reference(f.b), version: "sha256:" + "b".repeat(64) }, state: "available" }, ...f.response.sourceStates.slice(1)],
      [...f.response.sourceStates, f.response.sourceStates[1]]]) {
      expect(await readAssessmentResponseV2({ ...f.response, sourceStates: states }, scope)).toBeNull();
    }
  });
  it("refuses unknown, selected/future, malformed and unavailable transitive revision witnesses", async () => {
    const f = chain();
    const bad = [
      { source: { ...reference(f.a), id: 999 }, state: "available" },
      { source: reference(f.c), state: "available" },
      { source: { ...reference(f.a), version: "unverified" }, state: "available" },
      { source: reference(f.a), state: "unavailable" },
      { source: reference(f.a), state: "changed" },
    ];
    for (const state of bad) expect(await readAssessmentResponseV2({ ...f.response, sourceStates: [f.response.sourceStates[0], state] }, scope)).toBeNull();
    const later = revision(80, 4, f.c.id);
    expect(await readAssessmentResponseV2({ ...f.response, history: [later, f.c, f.b, f.a].map(entry),
      sourceStates: [...f.response.sourceStates, { source: reference(later), state: "available" }] }, { ...scope, revisionId: f.c.id })).toBeNull();
  });
  it("requires a direct revision root and rejects transitive imaging under current restricted access", async () => {
    const f = chain(), noRoot = revision(60, 3, f.b.id);
    expect(await readAssessmentResponseV2({ ...f.response, revision: noRoot, history: [noRoot, f.b, f.a].map(entry) }, scope)).toBeNull();
    expect(await readAssessmentResponseV2({ ...f.response, sources: { ...f.response.sources, imaging: "restricted" } }, scope)).toBeNull();
    expect(await readAssessmentResponseV2({ ...f.response, clinicalCaseId: 30 }, scope)).toBeNull();
  });
  it("rejects a same-history earlier revision that cannot precede the selected direct root", async () => {
    const f = chain(), c = revision(60, 3, f.b.id, [reference(f.a)]);
    expect(await readAssessmentResponseV2({ ...f.response, revision: c, history: [c, f.b, f.a].map(entry),
      sourceStates: [{ source: reference(f.a), state: "available" }, { source: reference(f.b), state: "available" }] }, scope)).toBeNull();
  });
});
