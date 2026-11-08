import { cephProvenanceHash, buildCephCompletionWitness, buildReviewedCephCompletionWitness, cephSourceIdentity } from "../../lib/ceph-completion-provenance";

/** Synthetic fixture only. Presenter never imports these builders. */
export function completionEvidence(version: 1 | 2 = 1) {
  const input: Parameters<typeof buildCephCompletionWitness>[0] = {
    analysisId: 71, actor: { userId: 9, username: "SAVED_SEAL_ACTOR" }, sealedAt: "2026-11-05T12:34:56.000Z",
    snapshot: { patientId: 11, documentId: 51, refSet: "synthetic-saved", calibration: { x1: 0, y1: 12.5, x2: 80, y2: 12.5, mm: 10 }, mmPerPixel: 0.125,
      landmarks: [{ code: "S", x: 10, y: 20, source: "manual" }], diagnosis: null },
    image: { documentId: 51, sha256: "a".repeat(64), width: 800, height: 600 },
    landmarkReviews: [{ code: "S", confirmedBy: "SAVED_REVIEWER", confirmedAt: "2026-11-05T11:00:00.000Z" }],
    referenceSet: { key: "synthetic-saved", name: "Saved reference", population: null, ageMin: null, ageMax: null, sex: null, version: "v1", active: true, values: [] }, measurements: [{ code: "SNA", value: 82 }],
  };
  return version === 1 ? buildCephCompletionWitness(input) : buildReviewedCephCompletionWitness(input, cephSourceIdentity(input.image, input.referenceSet));
}

export function completionProvenance(version: 1 | 2 = 1) {
  const witness = completionEvidence(version);
  return { state: "versioned" as const, witness, witnessSha256: cephProvenanceHash(witness) };
}
