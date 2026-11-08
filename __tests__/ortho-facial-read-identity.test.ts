import { describe, expect, it } from "vitest";
import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import { computeFacialResults } from "../lib/ortho-facial-analysis";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { readFacialRead, verifyFacialRevision, type FacialRead, type FacialRevision } from "../lib/ortho-facial-records";
// Independently authored test roles; not identifiers, dates or notes from a patient record.
const SYN = {
  patient: 21001, orthoCase: 22001, clinicalCase: 23001, actor: 24001,
  document: 25001, revisionBase: 26000, submission: 27001,
  timestamp: '2001-02-03T04:05:06.000Z',
};


const scope = { patientId: SYN.patient, orthoCaseId: SYN.orthoCase, clinicalCaseId: SYN.clinicalCase };
const documentId = SYN.document;

function revision(version: number, id: number, expectedHeadId: number | null): FacialRevision {
  const content = syntheticFace();
  const command = {
    schemaVersion: 1 as const,
    clientRequestId: `synthetic_distinct_revision_${version}`,
    documentId,
    expectedHeadId,
    reason: 'SYNTHETIC READ-IDENTITY REASON 1',
    content,
  };
  const results = computeFacialResults(content);
  return {
    ...scope, id, version, documentId, recordedPatientId: scope.patientId, actorId: SYN.actor,
    createdBy: 'SYNTHETIC READ-IDENTITY CREATEDBY 1', createdAt: SYN.timestamp, command, results,
    requestFingerprint: journeyContentHash(command), contentHash: journeyContentHash({ content, results }),
  };
}

function read(history: FacialRevision[]): FacialRead {
  const image = history[0].command.content.image;
  return {
    ok: true, ...scope, actorId: SYN.actor, canWrite: true, selectedDocumentId: documentId,
    documents: [{ id: documentId, title: 'SYNTHETIC READ-IDENTITY TITLE 1', sha256: image.sha256, takenOn: null }],
    documentsTruncated: false, image, history, historyTruncated: false,
  };
}

describe("facial initial history requires distinct revision identities", () => {
  it("retains valid contiguous history with distinct IDs and exact hashes", async () => {
    const raw = read([revision(2, SYN.revisionBase + 1, SYN.revisionBase + 2), revision(1, SYN.revisionBase + 2, null)]);
    await expect(readFacialRead(raw, scope, documentId)).resolves.toEqual(raw);
  });

  it.each([
    { label: "adjacent", history: () => [revision(2, SYN.revisionBase + 2, SYN.revisionBase + 2), revision(1, SYN.revisionBase + 2, null)] },
    { label: "nonadjacent", history: () => [revision(3, SYN.revisionBase + 3, SYN.revisionBase + 1), revision(2, SYN.revisionBase + 1, SYN.revisionBase + 3), revision(1, SYN.revisionBase + 3, null)] },
  ])("refuses $label reused IDs even when versions, head links and hashes are valid", async ({ history }) => {
    const raw = read(history());
    for (const row of raw.history) await expect(verifyFacialRevision(row, scope)).resolves.toEqual(row);
    expect(new Set(raw.history.map(row => row.id)).size).toBeLessThan(raw.history.length);
    await expect(readFacialRead(raw, scope, documentId)).rejects.toThrow("invalid_facial_record");
  });
});
