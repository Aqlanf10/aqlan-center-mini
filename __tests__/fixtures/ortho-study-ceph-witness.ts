/** Synthetic evidence only. Independent from today's engine/reference registry. */
import type { CephCompletionWitnessV1, CephCompletionWitnessV2 } from "../../lib/ceph-completion-provenance";
import type { WitnessedStudyCephCaptureV2, WitnessedStudyCephCaptureV3 } from "../../lib/ortho-study-ceph-capture";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
export function syntheticStudyCephWitness(): CephCompletionWitnessV1 {
  const referenceSet = { key: "synthetic_saved", name: "Synthetic saved cohort", population: "Synthetic population only", ageMin: 12,
    ageMax: 14, sex: null, version: "synthetic-v1", active: true, values: [{ code: "SNA", mean: 85, sd: 3 }] };
  return { schemaVersion: 1, analysisId: 7, recordedPatientId: 11, actor: { userId: 9, username: "synthetic-doctor" },
    sealedAt: "2026-11-05T12:00:00.000Z", snapshot: { patientId: 11, documentId: 22, refSet: referenceSet.key,
      calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1,
      landmarks: [{ code: "S", x: 10, y: 20, source: "manual" }],
      diagnosis: { skeletal: "Synthetic skeletal", dental: null, softTissue: null, note: null, finalDx: "Synthetic diagnosis" } },
    image: { documentId: 22, sha256: "a".repeat(64), width: 800, height: 600 },
    landmarkReviews: [{ code: "S", confirmedBy: "synthetic-reviewer", confirmedAt: "2026-11-05T11:00:00.000Z" }],
    referenceSet, referenceSetSha256: journeyContentHash(referenceSet), measurements: [{ code: "SNA", value: 82, unit: "°",
      algorithm: { id: "aqlan-ceph:SNA", version: "synthetic-saved-engine", sourceSha256: "b".repeat(64), calculationVersion: null, rounding: "one_decimal_math_round" },
      reference: { origin: "selected_reference_set", mean: 85, sd: 3, source: "synthetic_saved@synthetic-v1", sourceUrl: null,
        populationReference: null, patientSpecificSuitability: "not_validated" } }],
    clinicalMeaning: "clinician_attested_inputs_not_independent_clinical_validation",
    sourceIdentityMeaning: "server_captured_at_completion_not_confirmed_as_viewed" };
}
export function syntheticWitnessedStudyCephCapture(): WitnessedStudyCephCaptureV2 {
  const witness = syntheticStudyCephWitness();
  return { captureVersion: 2, id: witness.analysisId, status: "completed", phase: "pre", acquisitionDate: null, device: null,
    studyKind: "lateral", note: null, createdAt: "2026-11-04T10:00:00.000Z", createdBy: "synthetic-doctor",
    completion: { witness, witnessSha256: journeyContentHash(witness) } };
}

/** Explicit source-bound fixture; never reinterpret or mutate the v1 fixture. */
export function syntheticSourceBoundStudyCephWitness(): CephCompletionWitnessV2 {
  const original = syntheticStudyCephWitness();
  return { ...original, schemaVersion: 2, sourceIdentityMeaning: "submitted_source_identity_matches_server_capture",
    sourceReview: { schemaVersion: 1, identity: { schemaVersion: 1, documentId: original.image.documentId,
      imageSha256: original.image.sha256, referenceSetKey: original.referenceSet.key, referenceSetSha256: original.referenceSetSha256,
      engineVersion: original.measurements[0].algorithm.version, engineSourceSha256: original.measurements[0].algorithm.sourceSha256 } } };
}
export function syntheticSourceBoundStudyCephCapture(): WitnessedStudyCephCaptureV3 {
  const witness = syntheticSourceBoundStudyCephWitness();
  return { ...syntheticWitnessedStudyCephCapture(), captureVersion: 3, completion: { witness, witnessSha256: journeyContentHash(witness) } };
}
