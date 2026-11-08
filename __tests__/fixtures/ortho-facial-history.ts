import { syntheticFace } from "./ortho-facial-analysis";
import { computeFacialResults } from "../../lib/ortho-facial-analysis";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import type { FacialRead, FacialRevision } from "../../lib/ortho-facial-records";
export function facialHistoryFixture(count = 65) {
  const history: FacialRevision[] = [];
  for (let version = count; version >= 1; version--) {
    const content = syntheticFace(), results = computeFacialResults(content);
    const command = { schemaVersion: 1 as const, clientRequestId: `synthetic_history_${version}`, documentId: 91, expectedHeadId: version > 1 ? 100 + version - 1 : null, reason: `Saved reason ${version}`, content };
    history.push({ patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, id: 100 + version, version, documentId: 91, recordedPatientId: 1, actorId: 4,
      createdBy: "Synthetic saved recorder", createdAt: "2026-11-06T01:00:00.000Z", command, results, requestFingerprint: journeyContentHash(command), contentHash: journeyContentHash({ content, results }) });
  }
  const data: FacialRead = { ok: true, patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, actorId: 4, canWrite: true,
    documents: [{ id: 91, title: "Synthetic face", sha256: history[0].command.content.image.sha256, takenOn: null }], documentsTruncated: false,
    selectedDocumentId: 91, image: history[0].command.content.image, history: history.slice(0, 30), historyTruncated: count > 30 };
  const page = (anchor: FacialRevision) => {
    const older = history.filter(row => row.version < anchor.version);
    return { ok: true as const, patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, actorId: 4, documentId: 91, image: data.image!, anchor, history: older.slice(0, 30), hasMore: older.length > 30 };
  };
  return { data, history, page };
}
