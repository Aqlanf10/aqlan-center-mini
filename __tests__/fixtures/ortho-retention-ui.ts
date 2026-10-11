/** Synthetic documentary data only; IDs deliberately differ from case versions. */
import { createHash } from "node:crypto";
import { canonicalJourneyJSON } from "../../lib/ortho-case-journey-json";
import { projectRetentionEventHistory, type RetentionEventRecord } from "../../lib/ortho-retention-event-history";
import type { RetentionEvent } from "../../lib/ortho-retention-events";
import type { RetentionRead, RetentionRevision, RetentionSaveExpectation } from "../../lib/ortho-retention-client";
export const scope = { patientId: 71, orthoCaseId: 81, clinicalCaseId: 91 };
export const hash = (value: unknown) => createHash("sha256").update(canonicalJourneyJSON(value)).digest("hex");
export const occurrence = { occurredOn: null, dateProvenance: "unknown" as const, sourceNote: "" };
export function delivery(description = "Synthetic fixed retainer"): RetentionEvent {
  return { kind: "device_delivery", occurrence: { ...occurrence }, note: "", documentIds: [], deviceType: "fixed", description, extent: "13–23", labOrderId: null };
}
export function row(id: number, version: number, content: RetentionEvent, extra: Partial<RetentionEventRecord> = {}): RetentionEventRecord {
  return { id, version, arch: "upper", supersedesEntryId: null, archCorrectionReason: null, content, ...extra };
}
export function readFixture(rows: RetentionEventRecord[] = [], selectedId?: number): RetentionRead {
  const ordered = [...rows].sort((a, b) => a.version - b.version);
  const revisions: RetentionRevision[] = ordered.map((r, index) => {
    const content = { arch: r.arch, supersedesEntryId: r.supersedesEntryId, archCorrectionReason: r.archCorrectionReason, payload: r.content };
    return { ...scope, id: r.id, recordedPatientId: scope.patientId, schemaVersion: 1, version: r.version, predecessorId: ordered[index - 1]?.id ?? null,
      createdBy: "Synthetic clinician", createdAt: "2026-10-01T00:00:00.000Z", reason: "Synthetic documentary event", recordingContext: "current", caseStatusAtCapture: "retention", contentHash: hash(content), content };
  });
  const projected = projectRetentionEventHistory(rows); if (!projected.ok) throw new Error(projected.code);
  return { ok: true, ...scope, status: "retention", recordingContext: "current", planId: null,
    revision: (selectedId === undefined ? revisions.at(-1) : revisions.find(r => r.id === selectedId)) ?? null,
    ...projected.value, canAppend: true, history: [...revisions].reverse().map(r => ({ id: r.id, version: r.version, predecessorId: r.predecessorId, createdAt: r.createdAt, contentHash: r.contentHash })) };
}
export function expectation(): RetentionSaveExpectation {
  return { scope: { ...scope }, actorId: 17, previousVersion: 0, command: { schemaVersion: 1, clientRequestId: "synthetic_retention_001",
    expectedHeadId: null, reason: "Synthetic documentary event", arch: "upper", supersedesEntryId: null, archCorrectionReason: null, content: delivery() } };
}
export function savedFixture(expected = expectation(), replayed = false) {
  const revision = readFixture([row(111, 1, expected.command.content)]).revision!;
  revision.reason = expected.command.reason;
  return { ok: true, replayed, revision, acknowledgment: { schemaVersion: 1, actorId: expected.actorId, commandId: expected.command.clientRequestId,
    requestFingerprint: hash(expected.command), revisionId: revision.id } };
}
