/** Server-owned evidence for NEW completions only. Hashes detect corruption;
 * they are not digital signatures or proof of clinical validation. */
import { MEASUREMENTS, type CephPopulationReference } from "./ceph";
import { parseCephCompletionSnapshot, sameCephCompletionSnapshot, type CephCompletionSnapshot } from "./ceph-completion-snapshot";
import { journeyContentHash } from "./ortho-case-journey-hash";
import type { DbClient } from "./db";
import { parseCephSourceIdentity, sameCephSourceIdentity, type CephSourceIdentity, type CephCompletionSources } from "./ceph-source-review";
import { CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "./ceph-engine-identity";
export { CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "./ceph-engine-identity";

// Deliberately versioned with the exact engine source, not today's guessed unit
// for a historical code. The regression test requires maintenance on any change.
export const cephProvenanceHash = journeyContentHash;
export interface CephReferenceSnapshot {
  key: string; name: string; population: string | null; ageMin: number | null; ageMax: number | null;
  sex: string | null; version: string; active: boolean; values: { code: string; mean: number; sd: number }[];
}
export interface CephMeasurementWitness {
  code: string; value: number; unit: "°" | "mm" | "%" | "";
  algorithm: { id: string; version: string; sourceSha256: string; calculationVersion: string | null; rounding: "one_decimal_math_round" };
  reference: { origin: "selected_reference_set" | "builtin_definition_fallback" | "descriptive_cohort_only" | "descriptive_measurement_only";
    mean: number | null; sd: number | null; source: string; sourceUrl: string | null;
    populationReference: CephPopulationReference | null; patientSpecificSuitability: "not_validated" };
}
export interface CephCompletionWitnessV1 {
  schemaVersion: 1; analysisId: number; recordedPatientId: number;
  actor: { userId: number; username: string }; sealedAt: string;
  snapshot: CephCompletionSnapshot;
  image: { documentId: number; sha256: string; width: number | null; height: number | null };
  landmarkReviews: { code: string; confirmedBy: string; confirmedAt: string }[];
  referenceSet: CephReferenceSnapshot; referenceSetSha256: string;
  measurements: CephMeasurementWitness[];
  clinicalMeaning: "clinician_attested_inputs_not_independent_clinical_validation";
  sourceIdentityMeaning: "server_captured_at_completion_not_confirmed_as_viewed";
}
export interface CephCompletionWitnessV2 extends Omit<CephCompletionWitnessV1,"schemaVersion"|"sourceIdentityMeaning"> {
  schemaVersion: 2;
  sourceIdentityMeaning: "submitted_source_identity_matches_server_capture";
  sourceReview: {schemaVersion:1;identity:CephSourceIdentity};
}
export type CephCompletionWitness = CephCompletionWitnessV1 | CephCompletionWitnessV2;

export type CephProvenanceRead =
  | { state: "not_completed" }
  | { state: "unversioned"; reason: "historical_completion_without_witness" }
  | { state: "integrity_unavailable"; reason: string }
  | { state: "versioned"; witness: CephCompletionWitness; witnessSha256: string };

export function buildCephCompletionWitness(input: {
  analysisId: number; actor: CephCompletionWitness["actor"]; sealedAt: string; snapshot: CephCompletionSnapshot;
  image: CephCompletionWitness["image"]; landmarkReviews: CephCompletionWitness["landmarkReviews"];
  referenceSet: CephReferenceSnapshot; measurements: { code: string; value: number }[];
}): CephCompletionWitnessV1 {
  const snapshot = parseCephCompletionSnapshot(input.snapshot);
  if (!snapshot) throw new Error("Invalid completion snapshot");
  const referenceSet = { ...input.referenceSet, values: [...input.referenceSet.values].sort(byCode) };
  const measurements = input.measurements.map(({ code, value }): CephMeasurementWitness => {
    const d = MEASUREMENTS.find(item => item.code === code);
    if (!d || !Number.isFinite(value)) throw new Error("Unknown or invalid measurement");
    const reference = referenceSet.values.find(item => item.code === code);
    const descriptive = d.descriptiveOnly === true;
    return { code, value, unit: d.unit,
      algorithm: { id: `aqlan-ceph:${code}`, version: CEPH_ENGINE_VERSION, sourceSha256: CEPH_ENGINE_SOURCE_SHA256,
        calculationVersion: d.calculationVersion ?? null, rounding: "one_decimal_math_round" },
      reference: { origin: descriptive ? (d.populationReference ? "descriptive_cohort_only" : "descriptive_measurement_only") : reference ? "selected_reference_set" : "builtin_definition_fallback",
        mean: descriptive ? null : reference?.mean ?? d.mean, sd: descriptive ? null : reference?.sd ?? d.tol,
        source: !descriptive && reference ? `${referenceSet.key}@${referenceSet.version}` : d.source,
        sourceUrl: descriptive || !reference ? d.sourceUrl ?? null : null,
        populationReference: d.populationReference ?? null, patientSpecificSuitability: "not_validated" } };
  }).sort(byCode);
  // Deep clone makes evidence independent from mutable registry/reference input.
  const witness: CephCompletionWitnessV1 = JSON.parse(JSON.stringify({ schemaVersion: 1, analysisId: input.analysisId,
    recordedPatientId: snapshot.patientId, actor: input.actor, sealedAt: input.sealedAt, snapshot, image: input.image,
    landmarkReviews: [...input.landmarkReviews].sort(byCode), referenceSet, referenceSetSha256: cephProvenanceHash(referenceSet), measurements,
    clinicalMeaning: "clinician_attested_inputs_not_independent_clinical_validation",
    sourceIdentityMeaning: "server_captured_at_completion_not_confirmed_as_viewed" }));
  if (!decodeCephCompletionWitness(witness, cephProvenanceHash(witness))) throw new Error("Invalid completion provenance");
  return witness;
}
const byCode = (a: { code: string }, b: { code: string }) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 4000;
const nullableString = (x: unknown) => x === null || str(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const id = (x: unknown): x is number => num(x) && Number.isSafeInteger(x) && x > 0;
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const time = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(x) && Number.isFinite(Date.parse(x));
const fields = (x: Record<string, unknown>, names: string[]) => Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x,k));

/** No current algorithm registry is consulted while reading saved evidence. */
export function decodeCephCompletionWitnessV1(raw: unknown, expectedHash: unknown): CephCompletionWitnessV1 | null {
  try {
    if (!obj(raw) || !hash(expectedHash) || cephProvenanceHash(raw) !== expectedHash
      || !fields(raw, ["schemaVersion","analysisId","recordedPatientId","actor","sealedAt","snapshot","image","landmarkReviews","referenceSet","referenceSetSha256","measurements","clinicalMeaning","sourceIdentityMeaning"])
      || raw.schemaVersion !== 1 || !id(raw.analysisId) || !id(raw.recordedPatientId) || !time(raw.sealedAt)
      || raw.clinicalMeaning !== "clinician_attested_inputs_not_independent_clinical_validation"
      || raw.sourceIdentityMeaning !== "server_captured_at_completion_not_confirmed_as_viewed") return null;
    const s = parseCephCompletionSnapshot(raw.snapshot), a = raw.actor, image = raw.image, r = raw.referenceSet;
    if (!s || cephProvenanceHash(s) !== cephProvenanceHash(raw.snapshot) || s.patientId !== raw.recordedPatientId
      || !s.calibration || !num(s.mmPerPixel) || s.mmPerPixel <= 0
      || s.calibration.mm / Math.hypot(s.calibration.x2-s.calibration.x1,s.calibration.y2-s.calibration.y1) !== s.mmPerPixel
      || s.landmarks.some(p => p.source !== "manual")
      || !obj(a) || !fields(a,["userId","username"]) || !id(a.userId) || !str(a.username)
      || !obj(image) || !fields(image,["documentId","sha256","width","height"]) || image.documentId !== s.documentId || !hash(image.sha256)
      || !(image.width === null || id(image.width)) || !(image.height === null || id(image.height))
      || !obj(r) || !fields(r,["key","name","population","ageMin","ageMax","sex","version","active","values"])
      || r.key !== s.refSet || !str(r.name) || !nullableString(r.population) || !nullableString(r.sex) || !str(r.version) || r.active !== true
      || !(r.ageMin === null || num(r.ageMin)) || !(r.ageMax === null || num(r.ageMax))
      || !Array.isArray(r.values) || r.values.length > 256 || raw.referenceSetSha256 !== cephProvenanceHash(r)) return null;
    const referenceCodes = new Set<string>();
    for (const v of r.values) {
      if (!obj(v) || !fields(v,["code","mean","sd"]) || !str(v.code) || referenceCodes.has(v.code) || !num(v.mean) || !num(v.sd) || v.sd<=0) return null;
      referenceCodes.add(v.code);
    }
    if (!Array.isArray(raw.landmarkReviews) || raw.landmarkReviews.length !== s.landmarks.length) return null;
    const reviews = new Set<string>();
    for (const p of raw.landmarkReviews) {
      if (!obj(p) || !fields(p,["code","confirmedBy","confirmedAt"]) || !str(p.code) || reviews.has(p.code)
        || !s.landmarks.some(q=>q.code===p.code) || !str(p.confirmedBy) || !time(p.confirmedAt)) return null;
      reviews.add(p.code);
    }
    if (!Array.isArray(raw.measurements) || raw.measurements.length === 0 || raw.measurements.length > 256) return null;
    const codes = new Set<string>();
    for (const m of raw.measurements) {
      if (!obj(m) || !fields(m,["code","value","unit","algorithm","reference"]) || !str(m.code) || codes.has(m.code) || !num(m.value)
        || !["°","mm","%",""].includes(m.unit as string) || !obj(m.algorithm) || !obj(m.reference)) return null;
      const alg=m.algorithm, ref=m.reference;
      if (!fields(alg,["id","version","sourceSha256","calculationVersion","rounding"]) || alg.id !== `aqlan-ceph:${m.code}`
        || !str(alg.version) || !hash(alg.sourceSha256) || !nullableString(alg.calculationVersion) || alg.rounding !== "one_decimal_math_round"
        || !fields(ref,["origin","mean","sd","source","sourceUrl","populationReference","patientSpecificSuitability"])
        || !["selected_reference_set","builtin_definition_fallback","descriptive_cohort_only","descriptive_measurement_only"].includes(ref.origin as string)
        || !(ref.mean === null || num(ref.mean)) || !(ref.sd === null || num(ref.sd) && ref.sd>0) || !str(ref.source)
        || !nullableString(ref.sourceUrl) || ref.patientSpecificSuitability !== "not_validated") return null;
      if (["descriptive_cohort_only","descriptive_measurement_only"].includes(ref.origin as string) && (ref.mean !== null || ref.sd !== null)) return null;
      if (ref.origin === "descriptive_measurement_only" && ref.populationReference !== null) return null;
      if (ref.origin === "selected_reference_set") {
        const selected = r.values.find(v=>obj(v)&&v.code===m.code);
        if (!selected || selected.mean !== ref.mean || selected.sd !== ref.sd || ref.source !== `${r.key}@${r.version}`) return null;
      }
      if (ref.populationReference !== null) {
        const p=ref.populationReference;
        if (!obj(p) || !fields(p,["mean","sd","sampleSize","ageMin","ageMax","meanAge","boys","girls","population"])
          || ![p.mean,p.sd,p.sampleSize,p.ageMin,p.ageMax,p.meanAge,p.boys,p.girls].every(num) || !str(p.population)) return null;
      }
      codes.add(m.code);
    }
    return raw as unknown as CephCompletionWitnessV1;
  } catch { return null; }
}

/** A v1 witness can never gain v2 assurance by changing only its discriminator. */
export function decodeCephCompletionWitness(raw: unknown, expectedHash: unknown): CephCompletionWitness | null {
  if (!obj(raw) || raw.schemaVersion === 1) return decodeCephCompletionWitnessV1(raw,expectedHash);
  try {
    if (raw.schemaVersion !== 2 || !hash(expectedHash) || cephProvenanceHash(raw) !== expectedHash
      || raw.sourceIdentityMeaning !== "submitted_source_identity_matches_server_capture"
      || !obj(raw.sourceReview) || !fields(raw.sourceReview,["schemaVersion","identity"]) || raw.sourceReview.schemaVersion !== 1) return null;
    const identity=parseCephSourceIdentity(raw.sourceReview.identity);
    if (!identity) return null;
    const {sourceReview:_sourceReview,...base}=raw;
    const v1={...base,schemaVersion:1,sourceIdentityMeaning:"server_captured_at_completion_not_confirmed_as_viewed"};
    const checked=decodeCephCompletionWitnessV1(v1,cephProvenanceHash(v1));
    if (!checked || identity.documentId !== checked.image.documentId || identity.imageSha256 !== checked.image.sha256
      || identity.referenceSetKey !== checked.referenceSet.key || identity.referenceSetSha256 !== checked.referenceSetSha256
      || checked.measurements.some(m=>m.algorithm.version !== identity.engineVersion || m.algorithm.sourceSha256 !== identity.engineSourceSha256)) return null;
    return raw as unknown as CephCompletionWitnessV2;
  } catch { return null; }
}

export function cephSourceIdentity(image: CephCompletionWitness["image"], referenceSet: CephReferenceSnapshot): CephSourceIdentity {
  return {schemaVersion:1,documentId:image.documentId,imageSha256:image.sha256,referenceSetKey:referenceSet.key,
    referenceSetSha256:cephProvenanceHash(referenceSet),engineVersion:CEPH_ENGINE_VERSION,engineSourceSha256:CEPH_ENGINE_SOURCE_SHA256};
}
export function buildReviewedCephCompletionWitness(input: Parameters<typeof buildCephCompletionWitness>[0], expectedSources: CephSourceIdentity): CephCompletionWitnessV2 {
  const v1=buildCephCompletionWitness(input);
  const identity=cephSourceIdentity(v1.image,v1.referenceSet);
  if (!sameCephSourceIdentity(identity,expectedSources)) throw new Error("ceph_reviewed_sources_changed");
  const v2:CephCompletionWitnessV2={...v1,schemaVersion:2,sourceIdentityMeaning:"submitted_source_identity_matches_server_capture",
    sourceReview:{schemaVersion:1,identity:parseCephSourceIdentity(expectedSources)!}};
  if (!decodeCephCompletionWitness(v2,cephProvenanceHash(v2))) throw new Error("Invalid reviewed completion provenance");
  return v2;
}

/** One PostgreSQL statement binds catalog metadata and values to a single read
 * snapshot. The editor displays these exact values, not another catalog fetch. */
export async function readCephCompletionSources(client: Pick<DbClient,"query">, scope:{patientId:number;documentId:number;refSet:string}): Promise<CephCompletionSources> {
  const {rows:[r]}=await client.query<{document_id:number;sha256:string;width:number|null;height:number|null;reference:CephReferenceSnapshot}>(
    `SELECT d.id AS document_id,d.sha256,d.width,d.height,
      jsonb_build_object('key',s.key,'name',s.name,'population',s.population,'ageMin',s.age_min,'ageMax',s.age_max,
        'sex',s.sex,'version',s.version,'active',s.active,'values',COALESCE((SELECT jsonb_agg(jsonb_build_object('code',v.code,'mean',v.mean,'sd',v.sd) ORDER BY v.code)
        FROM ceph_reference_values v WHERE v.set_id=s.id),'[]'::jsonb)) AS reference
     FROM patient_documents d CROSS JOIN ceph_reference_sets s
     WHERE d.id=$1 AND d.patient_id=$2 AND d.removed_at IS NULL AND s.key=$3 AND s.active=TRUE`,
    [scope.documentId,scope.patientId,scope.refSet]);
  if (!r || !hash(r.sha256) || !validCephReferenceSnapshot(r.reference)) return {state:"unavailable",reason:"image_or_reference_source_unavailable"};
  const referenceSet={...r.reference,values:[...r.reference.values].sort(byCode)};
  return {state:"available",identity:cephSourceIdentity({documentId:r.document_id,sha256:r.sha256,width:r.width,height:r.height},referenceSet),referenceSet};
}
function validCephReferenceSnapshot(r:unknown): r is CephReferenceSnapshot {
  if (!obj(r) || !fields(r,["key","name","population","ageMin","ageMax","sex","version","active","values"])
    || !str(r.key) || !str(r.name) || !nullableString(r.population) || !nullableString(r.sex) || !str(r.version) || r.active !== true
    || !(r.ageMin === null || num(r.ageMin)) || !(r.ageMax === null || num(r.ageMax)) || !Array.isArray(r.values) || r.values.length>256) return false;
  const codes=new Set<string>();
  for (const value of r.values) {
    if (!obj(value) || !fields(value,["code","mean","sd"]) || !str(value.code) || codes.has(value.code) || !num(value.mean) || !num(value.sd) || value.sd<=0) return false;
    codes.add(value.code);
  }
  return true;
}

/** Called under patient, user and analysis locks. Reference catalog table SHARE
 * locks stop insertion phantoms as well as metadata/value edits until commit. */
export async function captureCephCompletionWitness(client: DbClient, input: {
  analysisId: number; actor: CephCompletionWitness["actor"]; snapshot: CephCompletionSnapshot; measurements: { code: string; value: number }[]; expectedSources: CephSourceIdentity;
}): Promise<CephCompletionWitnessV2> {
  const { rows: [image] } = await client.query<{ documentId: number; sha256: string; width: number|null; height: number|null }>(
    `SELECT id AS "documentId", sha256, width, height FROM patient_documents
     WHERE id=$1 AND patient_id=$2 AND removed_at IS NULL FOR SHARE`, [input.snapshot.documentId,input.snapshot.patientId]);
  if (!image || !hash(image.sha256)) throw new Error("ceph_image_integrity_unavailable");
  await client.query("LOCK TABLE ceph_reference_sets, ceph_reference_values IN SHARE MODE");
  const { rows:[set] } = await client.query<CephReferenceSnapshot & { id: number }>(
    `SELECT id, key, name, population, age_min AS "ageMin", age_max AS "ageMax", sex, version, active FROM ceph_reference_sets WHERE key=$1 AND active=TRUE`,[input.snapshot.refSet]);
  if (!set) throw new Error("ceph_reference_provenance_unavailable");
  const { rows:values } = await client.query<{code:string;mean:number;sd:number}>("SELECT code,mean,sd FROM ceph_reference_values WHERE set_id=$1 ORDER BY code",[set.id]);
  const { rows:reviews } = await client.query<{code:string;confirmedBy:string;confirmedAt:string}>(
    `SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[input.analysisId]);
  const { rows:[now] } = await client.query<{sealed_at:Date}>("SELECT clock_timestamp() AS sealed_at");
  return buildReviewedCephCompletionWitness({ ...input, sealedAt:now.sealed_at.toISOString(), image,
    landmarkReviews: reviews.map(p=>({code:p.code,confirmedBy:p.confirmedBy,confirmedAt:p.confirmedAt})),
    referenceSet:{key:set.key,name:set.name,population:set.population,ageMin:set.ageMin,ageMax:set.ageMax,sex:set.sex,version:set.version,active:set.active,values} },input.expectedSources);
}

type CurrentCephCompletion = { snapshot: CephCompletionSnapshot; measurements: {code:string;value:number}[] };

export async function readCephCompletionProvenance(client: Pick<DbClient,"query">, analysisId: number, status: string,
  current?: CurrentCephCompletion): Promise<CephProvenanceRead> {
  return readCephClinicalSeal(client, analysisId, status, current, false);
}

/** Correction-copy preserves hidden-image compatibility but still requires
 * exact sealed image identity and clinical content. Caller locks source image,
 * analysis and children and enforces current owner/access. This does not
 * authorize display or completion of the copied draft. */
export async function readCephCorrectionSourceProvenance(client: Pick<DbClient,"query">, analysisId: number, status: string,
  current?: CurrentCephCompletion): Promise<CephProvenanceRead> {
  return readCephClinicalSeal(client, analysisId, status, current, true);
}

async function readCephClinicalSeal(client: Pick<DbClient,"query">, analysisId: number, status: string,
  current: CurrentCephCompletion | undefined, allowHiddenImage: boolean): Promise<CephProvenanceRead> {
  if (status !== "completed") return {state:"not_completed"};
  const {rows:[p]} = await client.query<{witness:unknown;schema_version:number;witness_sha256:string;actor_user_id:number;sealed_by:string;sealed_at:Date;completed_by:string|null;completed_at:Date|null;status:string}>(
    `SELECT p.witness,p.schema_version,p.witness_sha256,p.actor_user_id,p.sealed_by,p.sealed_at,a.completed_by,a.completed_at,a.status
     FROM ceph_completion_provenance p JOIN ceph_analyses a ON a.id=p.analysis_id WHERE p.analysis_id=$1`,[analysisId]);
  if (!p) return {state:"unversioned",reason:"historical_completion_without_witness"};
  const witness=decodeCephCompletionWitness(p.witness,p.witness_sha256);
  if (!witness || witness.schemaVersion !== p.schema_version || witness.analysisId !== analysisId || witness.actor.userId !== p.actor_user_id || witness.actor.username !== p.sealed_by
    || witness.sealedAt !== p.sealed_at.toISOString() || p.status !== "completed"
    || p.completed_by !== p.sealed_by || p.completed_at?.toISOString() !== witness.sealedAt) return {state:"integrity_unavailable",reason:"invalid_completion_witness"};
  if (!current) return {state:"integrity_unavailable",reason:"current_clinical_state_unavailable"};
  const {rows:[image]} = await client.query<{sha256:string;patient_id:number;removed_at:Date|null;width:number|null;height:number|null}>(
    "SELECT sha256,patient_id,removed_at,width,height FROM patient_documents WHERE id=$1",[witness.image.documentId]);
  if (!image || (!allowHiddenImage && image.removed_at !== null) || image.patient_id !== current.snapshot.patientId
    || image.sha256 !== witness.image.sha256 || image.width !== witness.image.width || image.height !== witness.image.height)
    return {state:"integrity_unavailable",reason:"source_image_unavailable_or_changed"};
  const {rows:reviews} = await client.query<{code:string;confirmedBy:string;confirmedAt:string}>(
    `SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[analysisId]);
  const landmarkReviews = reviews.map(p=>({code:p.code,confirmedBy:p.confirmedBy,confirmedAt:p.confirmedAt})).sort(byCode);
  if (cephProvenanceHash(landmarkReviews) !== cephProvenanceHash(witness.landmarkReviews))
    return {state:"integrity_unavailable",reason:"landmark_review_provenance_changed"};
  {
    // Legal patient merges change current ownership, never recorded identity.
    const snapshot={...current.snapshot,patientId:witness.recordedPatientId};
    const measurements=[...current.measurements].sort(byCode);
    if (!sameCephCompletionSnapshot(snapshot,witness.snapshot) || cephProvenanceHash(measurements) !== cephProvenanceHash(witness.measurements.map(m=>({code:m.code,value:m.value}))))
      return {state:"integrity_unavailable",reason:"stored_clinical_state_differs_from_witness"};
  }
  return {state:"versioned",witness,witnessSha256:p.witness_sha256};
}
