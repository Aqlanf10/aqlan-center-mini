/** Additive correction ancestry. This is source identity, not clinical approval. */
export interface CephCorrectionOrigin {
  schemaVersion: 1;
  parentAnalysisId: number;
  recordedPatientId: number;
  orthoCaseId: number | null;
  documentId: number;
  parentCompletion: { state: "versioned"; witnessVersion: 1 | 2; witnessSha256: string }
    | { state: "unversioned"; reason: "historical_completion_without_witness" };
  /** Canonical observed source bytes, including any prior origin. */
  sourceSnapshotSha256: string;
}
export interface CephCorrectionSourceToken {
  /** sourceSha256 hashes the entire origin envelope, not only its snapshot. */
  schemaVersion: 1; analysisId: number; patientId: number; orthoCaseId: number | null; documentId: number; sourceSha256: string;
}
export type CephCorrectionSourceRead = { state: "available"; token: CephCorrectionSourceToken; origin: CephCorrectionOrigin }
  | { state: "unavailable"; reason: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseCephCorrectionOrigin(v: unknown): CephCorrectionOrigin | null {
  if (!object(v) || !keys(v, ["schemaVersion", "parentAnalysisId", "recordedPatientId", "orthoCaseId", "documentId", "parentCompletion", "sourceSnapshotSha256"])
    || v.schemaVersion !== 1 || !id(v.parentAnalysisId) || !id(v.recordedPatientId) || !(v.orthoCaseId === null || id(v.orthoCaseId))
    || !id(v.documentId) || !hash(v.sourceSnapshotSha256) || !object(v.parentCompletion)) return null;
  const p = v.parentCompletion;
  if (!(p.state === "versioned" && keys(p, ["state", "witnessVersion", "witnessSha256"]) && (p.witnessVersion === 1 || p.witnessVersion === 2) && hash(p.witnessSha256))
    && !(p.state === "unversioned" && keys(p, ["state", "reason"]) && p.reason === "historical_completion_without_witness")) return null;
  return { schemaVersion: 1, parentAnalysisId: v.parentAnalysisId, recordedPatientId: v.recordedPatientId,
    orthoCaseId: v.orthoCaseId, documentId: v.documentId, parentCompletion: { ...p } as CephCorrectionOrigin["parentCompletion"], sourceSnapshotSha256: v.sourceSnapshotSha256 };
}
export function parseCephCorrectionSourceToken(v: unknown): CephCorrectionSourceToken | null {
  if (!object(v) || !keys(v, ["schemaVersion", "analysisId", "patientId", "orthoCaseId", "documentId", "sourceSha256"])
    || v.schemaVersion !== 1 || !id(v.analysisId) || !id(v.patientId) || !(v.orthoCaseId === null || id(v.orthoCaseId)) || !id(v.documentId) || !hash(v.sourceSha256)) return null;
  return { schemaVersion: 1, analysisId: v.analysisId, patientId: v.patientId, orthoCaseId: v.orthoCaseId, documentId: v.documentId, sourceSha256: v.sourceSha256 };
}
export function sameCephCorrectionSource(a: unknown, b: unknown): boolean {
  const left = parseCephCorrectionSourceToken(a), right = parseCephCorrectionSourceToken(b);
  return !!left && !!right && Object.keys(left).every(key => left[key as keyof CephCorrectionSourceToken] === right[key as keyof CephCorrectionSourceToken]);
}
export function parseCephCorrectionCommand(v: unknown): { schemaVersion: 1; expectedCorrectionSource: CephCorrectionSourceToken } | null {
  if (!object(v) || !keys(v, ["schemaVersion", "expectedCorrectionSource"]) || v.schemaVersion !== 1) return null;
  const token = parseCephCorrectionSourceToken(v.expectedCorrectionSource);
  return token ? { schemaVersion: 1, expectedCorrectionSource: token } : null;
}
