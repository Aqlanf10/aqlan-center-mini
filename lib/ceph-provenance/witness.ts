/**
 * Completion witness for NEW cephalometric completions (adapted from #530 `ceph-completion-provenance`).
 *
 * Records, at the moment of completion and inside the same transaction: the saved clinical inputs (snapshot), the
 * exact image bytes digest, the reference set used for display, every sealed value with the engine that produced
 * it, the C2 completeness flag and the recorded legacy-definition difference, the actor, and the draft version the
 * request approved. Historical completions are never back-filled: they read as "unversioned".
 *
 * Meaning, stated in the record itself: clinician-attested inputs, not independent clinical validation; a hash
 * detects corruption, it is not a digital signature.
 */
import { computeAll, MEASUREMENTS } from "../ceph";
import { explainMeasurement } from "../ceph-availability";
import { LEGACY_DEFINITION_VERSIONS } from "../ceph-evidence/definition-versions";
import { cephContentHash } from "./canonical-json";
import { CEPH_ENGINE_ID, CEPH_ENGINE_SOURCE_SHA256, CEPH_ENGINE_VERSION } from "./engine-identity";
import { parseCephCompletionSnapshot, type CephCompletionSnapshot } from "./snapshot";
import { parseCephSourceIdentity, type CephSourceIdentity } from "./source-identity";
export { parseCephSourceIdentity, type CephSourceIdentity } from "./source-identity";

export interface CephReferenceSnapshot {
  readonly key: string; readonly name: string; readonly population: string | null; readonly ageMin: number | null;
  readonly ageMax: number | null; readonly sex: string | null; readonly version: string;
  readonly values: readonly { readonly code: string; readonly mean: number; readonly sd: number }[];
}

export interface CephRetainedRows {
  readonly landmarks: readonly { readonly code: string; readonly x: number; readonly y: number; readonly source: string; readonly confirmedBy: string; readonly confirmedAt: string }[];
  readonly measurements: readonly { readonly code: string; readonly value: number }[];
}

export interface CephMeasurementWitness {
  readonly code: string;
  readonly value: number;
  readonly unit: "°" | "mm" | "%" | "";
  readonly algorithm: { readonly id: string; readonly engineVersion: string; readonly engineSourceSha256: string; readonly rounding: "one_decimal_math_round" };
  readonly reference: { readonly origin: "selected_reference_set" | "builtin_definition_fallback"; readonly mean: number; readonly sd: number; readonly source: string; readonly patientSpecificSuitability: "not_validated" };
  /** C2: whether the legacy formula substituted an unmeasured component for this value. */
  readonly completeness: "measured" | "measured-with-assumption";
  /** Recorded legacy definition difference (lib/ceph-evidence/definition-versions), or null. */
  readonly legacyDefinitionDiffers: boolean;
}

export interface CephCompletionWitness {
  readonly schemaVersion: 1;
  readonly analysisId: number;
  readonly recordedPatientId: number;
  readonly actor: { readonly userId: number; readonly username: string; readonly role: string };
  readonly sealedAt: string;
  readonly approvedDraftVersion: string;
  readonly snapshot: CephCompletionSnapshot;
  readonly image: { readonly documentId: number; readonly sha256: string; readonly width: number | null; readonly height: number | null };
  readonly landmarkReviews: readonly { readonly code: string; readonly confirmedBy: string; readonly confirmedAt: string }[];
  readonly referenceSet: CephReferenceSnapshot | null;
  readonly sourceIdentity: CephSourceIdentity;
  readonly measurements: readonly CephMeasurementWitness[];
  /** Stored rows outside the engine (unknown historical codes), kept verbatim so a reader can check the FULL set. */
  readonly retained: CephRetainedRows;
  readonly clinicalMeaning: "clinician_attested_inputs_not_independent_clinical_validation";
  readonly sourceIdentityMeaning: "submitted_source_identity_matches_server_capture" | "server_captured_at_completion_not_confirmed_as_viewed";
}

const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 4000;
const nstr = (x: unknown) => x === null || str(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nnum = (x: unknown) => x === null || num(x);
const posId = (x: unknown): x is number => num(x) && Number.isSafeInteger(x) && x > 0;
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const iso = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(x) && Number.isFinite(Date.parse(x));
const keys = (x: Record<string, unknown>, names: readonly string[]) => Object.keys(x).length === names.length && names.every((k) => Object.hasOwn(x, k));
const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const LEGACY_DIFFERS = new Set(LEGACY_DEFINITION_VERSIONS.map((v) => v.legacyCode));

export function sameCephSourceIdentity(left: unknown, right: unknown): boolean {
  const a = parseCephSourceIdentity(left), b = parseCephSourceIdentity(right);
  return !!a && !!b && cephContentHash(a) === cephContentHash(b);
}

export function cephSourceIdentity(image: { documentId: number; sha256: string }, refSetKey: string, referenceSet: CephReferenceSnapshot | null): CephSourceIdentity {
  return { schemaVersion: 1, documentId: image.documentId, imageSha256: image.sha256, referenceSetKey: refSetKey,
    referenceSetSha256: referenceSet ? cephContentHash(referenceSet) : null,
    engineId: CEPH_ENGINE_ID, engineVersion: CEPH_ENGINE_VERSION, engineSourceSha256: CEPH_ENGINE_SOURCE_SHA256 };
}

function landmarkMap(snapshot: CephCompletionSnapshot) {
  return Object.fromEntries(snapshot.landmarks.map((p) => [p.code, { x: p.x, y: p.y }]));
}

/** Builds and self-checks the witness. `expectedSources` absent → recorded as not confirmed by the client. */
export function buildCephCompletionWitness(input: {
  analysisId: number; actor: CephCompletionWitness["actor"]; sealedAt: string; approvedDraftVersion: string;
  snapshot: CephCompletionSnapshot; image: CephCompletionWitness["image"];
  landmarkReviews: CephCompletionWitness["landmarkReviews"]; referenceSet: CephReferenceSnapshot | null;
  measurements: readonly { code: string; value: number }[]; expectedSources: CephSourceIdentity | null;
  retained?: CephRetainedRows;
}): CephCompletionWitness {
  const snapshot = parseCephCompletionSnapshot(input.snapshot);
  if (!snapshot) throw new Error("ceph_witness_snapshot_invalid");
  if (snapshot.documentId !== input.image.documentId || (input.referenceSet && input.referenceSet.key !== snapshot.refSet)) throw new Error("ceph_witness_scope_mismatch");
  const referenceSet = input.referenceSet ? { ...input.referenceSet, values: [...input.referenceSet.values].sort(byCode) } : null;
  const sourceIdentity = cephSourceIdentity(input.image, snapshot.refSet, referenceSet);
  if (input.expectedSources !== null && !sameCephSourceIdentity(sourceIdentity, input.expectedSources)) throw new Error("ceph_reviewed_sources_changed");
  const map = landmarkMap(snapshot);
  const scale = snapshot.mmPerPixel ?? Number.NaN;
  // A sealed value must be exactly what the named engine produces from the sealed inputs: never trust a caller value.
  const reproduced = new Map(computeAll(map, scale).map((r) => [r.code, r.value]));
  const measurements = input.measurements.map(({ code, value }): CephMeasurementWitness => {
    const def = MEASUREMENTS.find((m) => m.code === code);
    if (!def || !Number.isFinite(value)) throw new Error("ceph_witness_measurement_invalid");
    if (reproduced.get(code) !== value) throw new Error("ceph_witness_value_not_reproducible");
    const selected = referenceSet?.values.find((v) => v.code === code);
    const availability = explainMeasurement(code, map, scale);
    return {
      code, value, unit: def.unit,
      algorithm: { id: `${CEPH_ENGINE_ID}:${code}`, engineVersion: CEPH_ENGINE_VERSION, engineSourceSha256: CEPH_ENGINE_SOURCE_SHA256, rounding: "one_decimal_math_round" },
      reference: selected
        ? { origin: "selected_reference_set", mean: selected.mean, sd: selected.sd, source: `${referenceSet!.key}@${referenceSet!.version}`, patientSpecificSuitability: "not_validated" }
        : { origin: "builtin_definition_fallback", mean: def.mean, sd: def.tol, source: def.source, patientSpecificSuitability: "not_validated" },
      completeness: availability.status === "measured-with-assumption" ? "measured-with-assumption" : "measured",
      legacyDefinitionDiffers: LEGACY_DIFFERS.has(code),
    };
  }).sort(byCode);
  const witness: CephCompletionWitness = JSON.parse(JSON.stringify({
    schemaVersion: 1, analysisId: input.analysisId, recordedPatientId: snapshot.patientId, actor: input.actor, sealedAt: input.sealedAt,
    approvedDraftVersion: input.approvedDraftVersion, snapshot, image: input.image, landmarkReviews: [...input.landmarkReviews].sort(byCode),
    referenceSet, sourceIdentity, measurements,
    retained: { landmarks: [...(input.retained?.landmarks ?? [])].sort(byCode), measurements: [...(input.retained?.measurements ?? [])].sort(byCode) },
    clinicalMeaning: "clinician_attested_inputs_not_independent_clinical_validation",
    sourceIdentityMeaning: input.expectedSources ? "submitted_source_identity_matches_server_capture" : "server_captured_at_completion_not_confirmed_as_viewed",
  }));
  if (!decodeCephCompletionWitness(witness, cephContentHash(witness))) throw new Error("ceph_witness_invalid");
  return witness;
}

/** Reads saved evidence with no current registry or algorithm lookup: only structure and the stored hash. */
export function decodeCephCompletionWitness(raw: unknown, expectedHash: unknown): CephCompletionWitness | null {
  try {
    if (!obj(raw) || !sha(expectedHash) || cephContentHash(raw) !== expectedHash
      || !keys(raw, ["schemaVersion", "analysisId", "recordedPatientId", "actor", "sealedAt", "approvedDraftVersion", "snapshot", "image", "landmarkReviews", "referenceSet", "sourceIdentity", "measurements", "retained", "clinicalMeaning", "sourceIdentityMeaning"])
      || raw.schemaVersion !== 1 || !posId(raw.analysisId) || !posId(raw.recordedPatientId) || !iso(raw.sealedAt) || !sha(raw.approvedDraftVersion)
      || raw.clinicalMeaning !== "clinician_attested_inputs_not_independent_clinical_validation"
      || !["submitted_source_identity_matches_server_capture", "server_captured_at_completion_not_confirmed_as_viewed"].includes(raw.sourceIdentityMeaning as string)) return null;
    const snapshot = parseCephCompletionSnapshot(raw.snapshot);
    if (!snapshot || cephContentHash(snapshot) !== cephContentHash(raw.snapshot) || snapshot.patientId !== raw.recordedPatientId) return null;
    const actor = raw.actor, image = raw.image, ref = raw.referenceSet;
    if (!obj(actor) || !keys(actor, ["userId", "username", "role"]) || !posId(actor.userId) || !str(actor.username) || !str(actor.role)
      || !obj(image) || !keys(image, ["documentId", "sha256", "width", "height"]) || image.documentId !== snapshot.documentId || !sha(image.sha256)
      || !(image.width === null || posId(image.width)) || !(image.height === null || posId(image.height))) return null;
    if (ref !== null) {
      if (!obj(ref) || !keys(ref, ["key", "name", "population", "ageMin", "ageMax", "sex", "version", "values"]) || ref.key !== snapshot.refSet
        || !str(ref.name) || !nstr(ref.population) || !nnum(ref.ageMin) || !nnum(ref.ageMax) || !nstr(ref.sex) || !str(ref.version)
        || !Array.isArray(ref.values) || ref.values.length > 256) return null;
      const seen = new Set<string>();
      for (const v of ref.values) {
        if (!obj(v) || !keys(v, ["code", "mean", "sd"]) || !str(v.code) || seen.has(v.code) || !num(v.mean) || !num(v.sd) || v.sd <= 0) return null;
        seen.add(v.code);
      }
    }
    const identity = parseCephSourceIdentity(raw.sourceIdentity);
    if (!identity || identity.documentId !== image.documentId || identity.imageSha256 !== image.sha256 || identity.referenceSetKey !== snapshot.refSet
      || identity.referenceSetSha256 !== (ref === null ? null : cephContentHash(ref))) return null;
    if (!Array.isArray(raw.landmarkReviews) || raw.landmarkReviews.length !== snapshot.landmarks.length) return null;
    const reviewed = new Set<string>();
    for (const r of raw.landmarkReviews) {
      if (!obj(r) || !keys(r, ["code", "confirmedBy", "confirmedAt"]) || !str(r.code) || reviewed.has(r.code)
        || !snapshot.landmarks.some((p) => p.code === r.code) || !str(r.confirmedBy) || !iso(r.confirmedAt)) return null;
      reviewed.add(r.code);
    }
    if (!Array.isArray(raw.measurements) || raw.measurements.length === 0 || raw.measurements.length > 256) return null;
    const codes = new Set<string>();
    for (const m of raw.measurements) {
      if (!obj(m) || !keys(m, ["code", "value", "unit", "algorithm", "reference", "completeness", "legacyDefinitionDiffers"]) || !str(m.code) || codes.has(m.code)
        || !num(m.value) || !["°", "mm", "%", ""].includes(m.unit as string) || !obj(m.algorithm) || !obj(m.reference)
        || !["measured", "measured-with-assumption"].includes(m.completeness as string) || typeof m.legacyDefinitionDiffers !== "boolean") return null;
      const a = m.algorithm, r = m.reference;
      if (!keys(a, ["id", "engineVersion", "engineSourceSha256", "rounding"]) || a.id !== `${identity.engineId}:${m.code}`
        || a.engineVersion !== identity.engineVersion || a.engineSourceSha256 !== identity.engineSourceSha256 || a.rounding !== "one_decimal_math_round"
        || !keys(r, ["origin", "mean", "sd", "source", "patientSpecificSuitability"]) || !num(r.mean) || !num(r.sd) || !str(r.source)
        || r.patientSpecificSuitability !== "not_validated") return null;
      if (r.origin === "selected_reference_set") {
        const v = obj(ref) && Array.isArray(ref.values) ? (ref.values as { code: string; mean: number; sd: number }[]).find((x) => x.code === m.code) : undefined;
        if (!v || v.mean !== r.mean || v.sd !== r.sd || r.source !== `${(ref as Record<string, unknown>).key}@${(ref as Record<string, unknown>).version}`) return null;
      } else if (r.origin !== "builtin_definition_fallback") return null;
      codes.add(m.code);
    }
    const retained = raw.retained;
    if (!obj(retained) || !keys(retained, ["landmarks", "measurements"]) || !Array.isArray(retained.landmarks) || !Array.isArray(retained.measurements)
      || retained.landmarks.length > 256 || retained.measurements.length > 256) return null;
    const known = new Set<string>(snapshot.landmarks.map((p) => p.code));
    const retainedLandmarkCodes = new Set<string>();
    for (const l of retained.landmarks) {
      if (!obj(l) || !keys(l, ["code", "x", "y", "source", "confirmedBy", "confirmedAt"]) || !str(l.code) || l.code.length > 100 || known.has(l.code)
        || retainedLandmarkCodes.has(l.code) || !num(l.x) || !num(l.y) || !str(l.source) || !str(l.confirmedBy) || !iso(l.confirmedAt)) return null;
      retainedLandmarkCodes.add(l.code);
    }
    const retainedCodes = new Set<string>();
    for (const m of retained.measurements) {
      if (!obj(m) || !keys(m, ["code", "value"]) || !str(m.code) || m.code.length > 100 || codes.has(m.code) || retainedCodes.has(m.code) || !num(m.value)) return null;
      retainedCodes.add(m.code);
    }
    return raw as unknown as CephCompletionWitness;
  } catch { return null; }
}
